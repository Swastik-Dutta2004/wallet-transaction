import mongoose, { QueryFilter } from "mongoose";
import crypto from "crypto";
import { Response } from "express"
import walletModel from "../models/wallet.models"
import transactionModel, { ITransaction } from "../models/transaction.models";
import { AuthRequest } from "../middleware/auth.middleware"
import ledgerModel from "../models/ledger.models"


// Largest single operation we accept, in paise (Rs 10,00,000). Keeping a hard
// cap stops Math.round(amount * 100) from overflowing to Infinity and keeps
// balances well inside Number.MAX_SAFE_INTEGER.
const MAX_TRANSACTION_AMOUNT_IN_PAISE = 100_000_000

// Idempotency keys are trimmed before use and capped so a single header
// cannot be used to store unbounded strings in the database.
const MAX_IDEMPOTENCY_KEY_LENGTH = 255

const normaliseIdempotencyKey = (value: unknown): string | null => {
    if (typeof value !== "string") {
        return null
    }

    const key = value.trim()

    if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        return null
    }

    return key
}

// Direct wallet top-ups bypass Razorpay, so any logged-in user could mint
// money if this were always on. It fails closed: only an explicit opt-in or a
// recognised local/test environment enables it. Missing, misspelled or
// production-like NODE_ENV values can never enable it by accident.
const normaliseEnv = (value: string | undefined): string =>
    (value ?? "").trim().toLowerCase()

const nodeEnv = normaliseEnv(process.env.NODE_ENV)
const isDevelopment = ["development", "dev", "local", "test"].includes(nodeEnv)
const directCreditFlag = normaliseEnv(process.env.ALLOW_DIRECT_WALLET_CREDIT)

const directCreditEnabled =
    directCreditFlag === "true" ||
    (isDevelopment && directCreditFlag !== "false")

// MongoDB reports a violated unique index with error code 11000. This is the
// database-level guard that stops two concurrent requests that share an
// Idempotency-Key from both committing.
const isDuplicateKeyError = (error: unknown): boolean =>
    Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === 11000
    )

// Not every 11000 error is an idempotency conflict: any other unique index
// can produce one. Prefer the driver's keyPattern/keyValue, then fall back to
// the index name embedded in the error message.
const isIdempotencyDuplicateKeyError = (error: unknown): boolean => {
    if (!isDuplicateKeyError(error)) {
        return false
    }

    const duplicate = error as {
        keyPattern?: unknown;
        keyValue?: unknown;
        message?: string;
        err?: string;
    }

    const keysOf = (value: unknown): string[] =>
        value && typeof value === "object"
            ? Object.keys(value as Record<string, unknown>)
            : []

    const patternKeys = keysOf(duplicate.keyPattern)
    if (patternKeys.length > 0) {
        return patternKeys.length === 1 && patternKeys[0] === "idempotencyKey"
    }

    const valueKeys = keysOf(duplicate.keyValue)
    if (valueKeys.length > 0) {
        return valueKeys.length === 1 && valueKeys[0] === "idempotencyKey"
    }

    const detail = `${duplicate.message ?? ""} ${duplicate.err ?? ""}`

    return /index:\s*idempotencyKey_1\b/.test(detail)
}


// Expected business failures are thrown from inside a transaction so the
// transaction aborts cleanly, then mapped back to an HTTP status here.
class WalletRequestError extends Error {
    readonly status: number

    constructor(status: number, message: string) {
        super(message)
        this.name = "WalletRequestError"
        this.status = status
    }
}


// Run `work` inside a single MongoDB transaction and commit only when it
// resolves. `withTransaction` also retries on transient failures (write
// conflicts) and aborts automatically if `work` throws. A replica set is
// required for multi-document transactions.
const runInTransaction = async <T>(
    work: (session: mongoose.ClientSession) => Promise<T>
): Promise<T> => {

    const session = await mongoose.startSession()

    try {
        let outcome: { value: T } | undefined

        await session.withTransaction(async () => {
            outcome = { value: await work(session) }
        })

        if (!outcome) {
            throw new Error("Transaction finished without a result.")
        }

        return outcome.value
    } finally {
        await session.endSession()
    }
}


// A request fingerprint proves that a retry carrying the same Idempotency-Key
// also carries identical parameters. Without it a client could reuse a key
// with a different amount and either double-credit or silently get the wrong
// result. Only the hash is stored, never the raw request.
const hashRequest = (parts: ReadonlyArray<string | number>): string =>
    crypto
        .createHash("sha256")
        .update(JSON.stringify(parts))
        .digest("hex")

const walletFingerprint = (
    type: "CREDIT" | "DEBIT",
    walletId: unknown,
    amountInPaise: number,
    currency: string
): string =>
    hashRequest([type, String(walletId), amountInPaise, currency])

const transferFingerprint = (
    senderWalletId: unknown,
    receiverWalletId: unknown,
    amountInPaise: number,
    currency: string
): string =>
    hashRequest([
        "TRANSFER",
        String(senderWalletId),
        String(receiverWalletId),
        amountInPaise,
        currency
    ])

// Rows written before requestFingerprint existed have to be compared using a
// value derived from their stored fields, otherwise a retry of an old request
// would look like a parameter mismatch.
const fingerprintForTransaction = (transaction: {
    type?: string;
    walletId?: unknown;
    senderWalletId?: unknown;
    receiverWalletId?: unknown;
    amount?: number;
    currency?: string;
}): string => {
    const amount = transaction.amount ?? 0
    const currency = transaction.currency ?? "INR"

    if (transaction.type === "TRANSFER") {
        return transferFingerprint(
            transaction.senderWalletId,
            transaction.receiverWalletId,
            amount,
            currency
        )
    }

    return walletFingerprint(
        transaction.type === "DEBIT" ? "DEBIT" : "CREDIT",
        transaction.walletId,
        amount,
        currency
    )
}


type IdempotencyResolution =
    | { kind: "none" }
    | { kind: "replay"; transaction: ITransaction }


// Idempotency keys are globally unique (unique index on
// Transaction.idempotencyKey), so the lookup is global as well. A different
// wallet reusing the key is rejected rather than allowed to observe someone
// else's transaction.
const resolveIdempotency = async (
    idempotencyKey: string,
    expectedFingerprint: string,
    session: mongoose.ClientSession
): Promise<IdempotencyResolution> => {

    const existing = await transactionModel
        .findOne({ idempotencyKey })
        .session(session)

    if (!existing) {
        return { kind: "none" }
    }

    const existingFingerprint =
        existing.requestFingerprint ?? fingerprintForTransaction(existing)

    if (existingFingerprint !== expectedFingerprint) {
        throw new WalletRequestError(
            409,
            "Idempotency-Key has already been used with different request parameters."
        )
    }

    return { kind: "replay", transaction: existing }
}


const replayResponse = (transaction: ITransaction) => ({
    message: "Request already processed.",
    transaction: {
        id: transaction._id,
        type: transaction.type,
        amount: transaction.amount,
        status: transaction.status
    }
})


// Two identical requests can still race past resolveIdempotency, and a
// `withTransaction` commit can succeed even when the driver reports an
// uncertain error. In both cases re-reading the key decides whether the
// original result can safely be replayed.
const recoverIdempotentResult = async (
    idempotencyKey: string | null,
    expectedFingerprint: string | undefined
): Promise<
    { kind: "replay"; transaction: ITransaction } | { kind: "conflict" }
> => {

    if (!idempotencyKey || !expectedFingerprint) {
        return { kind: "conflict" }
    }

    const existing = await transactionModel.findOne({ idempotencyKey })

    if (!existing) {
        return { kind: "conflict" }
    }

    const existingFingerprint =
        existing.requestFingerprint ?? fingerprintForTransaction(existing)

    if (existingFingerprint !== expectedFingerprint) {
        return { kind: "conflict" }
    }

    return { kind: "replay", transaction: existing }
}


export const getWallet = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    try {
        const userId = req.user?.userId;

        if (!userId) {
            res.status(401).json({
                message: "User is not authenticated."
            })
            return
        }

        const wallet = await walletModel.findOne({
            ownerId: userId
        })

        if (!wallet) {
            res.status(404).json({
                message: "Wallet not found."
            })
            return
        }

        const reservedBalance = wallet.reservedBalance ?? 0

        res.status(200).json({
            wallet: {
                id: wallet._id,
                balance: wallet.balance,
                reservedBalance,
                availableBalance: wallet.balance - reservedBalance,
                currency: wallet.currency,
                status: wallet.status
            }
        })
    } catch (error) {
        console.log("Get wallet error: ", error);
        res.status(500).json({
            message: "Internal server error."
        })
    }
}


export const addMoney = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    // Read these before the try block so the duplicate-key recovery path in
    // catch can use them.
    const { amount } = req.body ?? {}
    const rawIdempotencyKey = req.headers["idempotency-key"]
    const idempotencyKey = normaliseIdempotencyKey(rawIdempotencyKey)
    const userId = req.user?.userId

    // Assigned inside the transaction; needed by duplicate-key recovery once
    // the transaction has been aborted.
    let expectedFingerprint: string | undefined

    try {

        if (!idempotencyKey) {

            res.status(400).json({
                message: rawIdempotencyKey === undefined
                    ? "Idempotency-Key header is required."
                    : "Invalid Idempotency-Key header."
            })

            return
        }

        if (!userId) {

            res.status(401).json({
                message: "User is not authenticated."
            })

            return
        }

        // Validate amount
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {

            res.status(400).json({
                message: "Amount must be greater than 0."
            })

            return
        }

        // Convert rupees to paise
        const amountInPaise = Math.round(amount * 100)

        // Reject amounts that round down to zero, overflow to Infinity, or
        // are larger than the allowed per-transaction maximum.
        if (!Number.isFinite(amountInPaise) || amountInPaise < 1) {

            res.status(400).json({
                message: "Amount must be at least 0.01."
            })

            return
        }

        if (amountInPaise > MAX_TRANSACTION_AMOUNT_IN_PAISE) {

            res.status(400).json({
                message: "Amount exceeds the maximum allowed per transaction."
            })

            return
        }

        const outcome = await runInTransaction(async (session) => {

            const wallet = await walletModel.findOne({
                ownerId: userId
            }).session(session)

            if (!wallet) {
                throw new WalletRequestError(404, "Wallet not found.")
            }

            const fingerprint = walletFingerprint(
                "CREDIT",
                wallet._id,
                amountInPaise,
                wallet.currency
            )
            expectedFingerprint = fingerprint

            // Resolve the key BEFORE checking the current wallet status: a
            // completed request must still be replayable if the wallet was
            // frozen afterwards.
            const idempotency = await resolveIdempotency(
                idempotencyKey,
                fingerprint,
                session
            )

            if (idempotency.kind === "replay") {
                return {
                    kind: "replay" as const,
                    transaction: idempotency.transaction
                }
            }

            // Only a NEW credit needs the feature flag. Replays of a
            // previously successful request must stay available even after
            // direct credit is turned off.
            if (!directCreditEnabled) {
                throw new WalletRequestError(
                    403,
                    "Direct wallet credit is disabled. Add money through the Razorpay order and verification flow."
                )
            }

            if (wallet.status !== "active") {
                throw new WalletRequestError(400, "Wallet is not active.")
            }

            // Atomic credit. $inc avoids the lost-update race a
            // read-modify-write (wallet.balance += amount; wallet.save())
            // would have with a concurrent credit or transfer. The $expr
            // guard refuses to operate on a wallet whose stored invariant is
            // already broken; schema validators do not run for $inc.
            const updatedWallet = await walletModel.findOneAndUpdate(
                {
                    _id: wallet._id,
                    status: "active",
                    $expr: {
                        $gte: [
                            "$balance",
                            { $ifNull: ["$reservedBalance", 0] }
                        ]
                    }
                },
                {
                    $inc: { balance: amountInPaise }
                },
                { new: true, session }
            )

            if (!updatedWallet) {
                throw new WalletRequestError(400, "Wallet is not active.")
            }

            const balanceAfter = updatedWallet.balance
            const balanceBefore = balanceAfter - amountInPaise

            // Create transaction
            const transaction = new transactionModel({
                walletId: updatedWallet._id,
                type: "CREDIT",
                amount: amountInPaise,
                currency: updatedWallet.currency,
                idempotencyKey,
                requestFingerprint: fingerprint,
                status: "Success",
                description: "Money added to wallet."
            })
            await transaction.save({ session })

            const ledger = new ledgerModel({
                walletId: updatedWallet._id,
                transactionId: transaction._id,
                type: "CREDIT",
                amount: amountInPaise,
                balanceBefore,
                balanceAfter,
                currency: updatedWallet.currency,
                description: "Money added to wallet."
            })

            await ledger.save({ session })

            return {
                kind: "created" as const,
                wallet: updatedWallet,
                transaction
            }
        })

        if (outcome.kind === "replay") {
            res.status(200).json(replayResponse(outcome.transaction))
            return
        }

        res.status(200).json({
            message: "Money added successfully.",
            wallet: {
                id: outcome.wallet._id,
                balance: outcome.wallet.balance,
                reservedBalance: outcome.wallet.reservedBalance ?? 0,
                currency: outcome.wallet.currency
            },
            transaction: {
                id: outcome.transaction._id,
                type: outcome.transaction.type,
                amount: outcome.transaction.amount,
                status: outcome.transaction.status
            }
        })

    } catch (error) {

        if (error instanceof WalletRequestError) {
            res.status(error.status).json({
                message: error.message
            })
            return
        }

        // Only the idempotency-key index can be recovered as a replay. Other
        // unique-index violations are unexpected database errors.
        if (isDuplicateKeyError(error)) {

            if (!isIdempotencyDuplicateKeyError(error)) {
                console.log("Add money error:", error)
                res.status(500).json({
                    message: "Internal server error."
                })
                return
            }

            const recovery = await recoverIdempotentResult(
                idempotencyKey,
                expectedFingerprint
            )

            if (recovery.kind === "replay") {
                res.status(200).json(replayResponse(recovery.transaction))
                return
            }

            res.status(409).json({
                message:
                    "Idempotency-Key has already been used with different request parameters."
            })
            return
        }

        // withTransaction may report an error after the commit actually
        // succeeded. Re-read the key before turning that into a 500 so a
        // retried request returns the original transaction.
        const recovery = await recoverIdempotentResult(
            idempotencyKey,
            expectedFingerprint
        )

        if (recovery.kind === "replay") {
            res.status(200).json(replayResponse(recovery.transaction))
            return
        }

        console.log("Add money error:", error)

        res.status(500).json({
            message: "Internal server error."
        })
    }
}


export const transferMoney = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    // Read these before the try block so the duplicate-key recovery path in
    // catch can use them.
    const { receiverId, amount } = req.body ?? {}
    const rawIdempotencyKey = req.headers["idempotency-key"]
    const idempotencyKey = normaliseIdempotencyKey(rawIdempotencyKey)
    const senderId = req.user?.userId

    // Assigned inside the transaction; needed by duplicate-key recovery once
    // the transaction has been aborted.
    let expectedFingerprint: string | undefined

    try {

        if (!idempotencyKey) {

            res.status(400).json({
                message: rawIdempotencyKey === undefined
                    ? "Idempotency-Key header is required."
                    : "Invalid Idempotency-Key header."
            })

            return
        }

        if (!senderId) {

            res.status(401).json({
                message: "User is not authenticated."
            })

            return
        }

        if (!receiverId || typeof receiverId !== "string") {

            res.status(400).json({
                message: "Receiver ID required."
            })

            return
        }

        if (!mongoose.isValidObjectId(receiverId)) {

            res.status(400).json({
                message: "Receiver ID is invalid."
            })

            return
        }

        // Validate amount
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {

            res.status(400).json({
                message: "Amount must be greater than 0."
            })

            return
        }

        // Convert rupees to paise
        const amountInPaise = Math.round(amount * 100)

        // Reject amounts that round down to zero, overflow to Infinity, or
        // are larger than the allowed per-transaction maximum.
        if (!Number.isFinite(amountInPaise) || amountInPaise < 1) {

            res.status(400).json({
                message: "Amount must be at least 0.01."
            })

            return
        }

        if (amountInPaise > MAX_TRANSACTION_AMOUNT_IN_PAISE) {

            res.status(400).json({
                message: "Amount exceeds the maximum allowed per transaction."
            })

            return
        }

        const outcome = await runInTransaction(async (session) => {

            // Find sender wallet
            const senderWallet = await walletModel.findOne({
                ownerId: senderId
            }).session(session)

            if (!senderWallet) {
                throw new WalletRequestError(404, "Sender wallet not found.")
            }

            // The receiver id is already validated, so the fingerprint can be
            // built before loading the receiver wallet. That lets a completed
            // transfer replay even if the receiver wallet is now unavailable.
            const fingerprint = transferFingerprint(
                senderWallet._id,
                new mongoose.Types.ObjectId(receiverId),
                amountInPaise,
                senderWallet.currency
            )
            expectedFingerprint = fingerprint

            // Resolve the key BEFORE the status/currency checks: a completed
            // request must replay even if either wallet was frozen later.
            const idempotency = await resolveIdempotency(
                idempotencyKey,
                fingerprint,
                session
            )

            if (idempotency.kind === "replay") {
                return {
                    kind: "replay" as const,
                    transaction: idempotency.transaction
                }
            }

            // Find receiver wallet
            const receiverWallet = await walletModel.findOne({
                ownerId: receiverId
            }).session(session)

            if (!receiverWallet) {
                throw new WalletRequestError(404, "Receiver wallet not found.")
            }

            // Sender and receiver cannot be the same.
            // Compared as ObjectIds so casing/format differences on the
            // receiver id cannot bypass the check.
            if (String(senderWallet._id) === String(receiverWallet._id)) {
                throw new WalletRequestError(
                    400,
                    "Sender and receiver cannot be the same."
                )
            }

            // Check wallet status
            if (
                senderWallet.status !== "active" ||
                receiverWallet.status !== "active"
            ) {
                throw new WalletRequestError(400, "Both wallets must be active.")
            }

            // Both sides must settle in the same currency
            if (senderWallet.currency !== receiverWallet.currency) {
                throw new WalletRequestError(
                    400,
                    "Both wallets must use the same currency."
                )
            }

            // Atomic sender debit. The $expr guard checks the spendable
            // balance (balance minus reservedBalance) inside the database, so
            // two concurrent transfers can never both spend the same rupees,
            // and funds reserved for in-flight refunds stay locked.
            const debitedSender = await walletModel.findOneAndUpdate(
                {
                    _id: senderWallet._id,
                    status: "active",
                    $expr: {
                        $gte: [
                            {
                                $subtract: [
                                    "$balance",
                                    { $ifNull: ["$reservedBalance", 0] }
                                ]
                            },
                            amountInPaise
                        ]
                    }
                },
                {
                    $inc: { balance: -amountInPaise }
                },
                { new: true, session }
            )

            if (!debitedSender) {
                throw new WalletRequestError(400, "Insufficient wallet balance.")
            }

            // Atomic receiver credit. If it fails, throw so the whole
            // transaction (including the sender debit) is rolled back.
            const creditedReceiver = await walletModel.findOneAndUpdate(
                {
                    _id: receiverWallet._id,
                    status: "active",
                    $expr: {
                        $gte: [
                            "$balance",
                            { $ifNull: ["$reservedBalance", 0] }
                        ]
                    }
                },
                {
                    $inc: { balance: amountInPaise }
                },
                { new: true, session }
            )

            if (!creditedReceiver) {
                throw new Error(
                    "Receiver wallet became unavailable during transfer."
                )
            }

            const senderBalanceBefore = debitedSender.balance + amountInPaise
            const senderBalanceAfter = debitedSender.balance
            const receiverBalanceBefore = creditedReceiver.balance - amountInPaise
            const receiverBalanceAfter = creditedReceiver.balance

            // Create transfer transaction
            const transaction = new transactionModel({
                senderWalletId: debitedSender._id,
                receiverWalletId: creditedReceiver._id,
                type: "TRANSFER",
                amount: amountInPaise,
                currency: debitedSender.currency,
                idempotencyKey,
                requestFingerprint: fingerprint,
                status: "Success",
                description: "Wallet-to-wallet transfer"
            })

            await transaction.save({ session })


            const senderLedger = new ledgerModel({
                walletId: debitedSender._id,
                transactionId: transaction._id,
                type: "DEBIT",
                amount: amountInPaise,
                balanceBefore: senderBalanceBefore,
                balanceAfter: senderBalanceAfter,
                currency: debitedSender.currency,
                description: "Wallet-to-wallet transfer"
            })

            await senderLedger.save({ session })


            const receiverLedger = new ledgerModel({
                walletId: creditedReceiver._id,
                transactionId: transaction._id,
                type: "CREDIT",
                amount: amountInPaise,
                balanceBefore: receiverBalanceBefore,
                balanceAfter: receiverBalanceAfter,
                currency: creditedReceiver.currency,
                description: "Wallet-to-wallet transfer"
            })

            await receiverLedger.save({ session })

            return {
                kind: "created" as const,
                transaction,
                senderWallet: debitedSender,
                receiverWallet: creditedReceiver
            }
        })

        if (outcome.kind === "replay") {
            res.status(200).json(replayResponse(outcome.transaction))
            return
        }

        res.status(200).json({
            message: "Money transferred successfully.",
            transfer: {
                transactionId: outcome.transaction._id,
                amount: outcome.transaction.amount,
                currency: outcome.transaction.currency,
                status: outcome.transaction.status
            },
            senderWallet: {
                id: outcome.senderWallet._id,
                balance: outcome.senderWallet.balance
            },
            receiverWallet: {
                id: outcome.receiverWallet._id,
                balance: outcome.receiverWallet.balance
            }
        })

    } catch (error) {

        if (error instanceof WalletRequestError) {
            res.status(error.status).json({
                message: error.message
            })
            return
        }

        // Only a genuine idempotency-key violation can be replayed; other
        // duplicate-key errors stay ordinary database failures.
        if (isDuplicateKeyError(error)) {

            if (!isIdempotencyDuplicateKeyError(error)) {
                console.log("Transfer error:", error)
                res.status(500).json({
                    message: "Internal server error."
                })
                return
            }

            const recovery = await recoverIdempotentResult(
                idempotencyKey,
                expectedFingerprint
            )

            if (recovery.kind === "replay") {
                res.status(200).json(replayResponse(recovery.transaction))
                return
            }

            res.status(409).json({
                message:
                    "Idempotency-Key has already been used with different request parameters."
            })
            return
        }

        // An uncertain commit error must not hide a transfer that already
        // succeeded; replay it if the key proves the same request.
        const recovery = await recoverIdempotentResult(
            idempotencyKey,
            expectedFingerprint
        )

        if (recovery.kind === "replay") {
            res.status(200).json(replayResponse(recovery.transaction))
            return
        }

        console.log("Transfer error:", error)

        res.status(500).json({
            message: "Internal server error."
        })
    }
}


export const getTransactions = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {
    try {

        const userId = req.user?.userId

        if (!userId) {
            res.status(401).json({
                message: "User authentication required."
            })
            return
        }

        // Find user's wallet
        const wallet = await walletModel.findOne({
            ownerId: userId
        })

        if (!wallet) {
            res.status(404).json({
                message: "Wallet not found."
            })
            return
        }

        // Cap the page size so an unbounded history query cannot pull the
        // whole collection into memory.
        const rawLimit = Number(req.query.limit)

        const limit =
            Number.isFinite(rawLimit) && rawLimit > 0
                ? Math.min(Math.floor(rawLimit), 100)
                : 50

        // Cursor pagination on _id (which is time ordered) instead of
        // skip/limit, so pages stay stable while new transactions are added
        // and the database never has to scan everything before the page.
        const rawCursor = req.query.cursor

        const filter: QueryFilter<ITransaction> = {
            $or: [
                { walletId: wallet._id },
                { senderWalletId: wallet._id },
                { receiverWalletId: wallet._id }
            ]
        }

        if (rawCursor !== undefined) {

            if (typeof rawCursor !== "string" || !mongoose.isValidObjectId(rawCursor)) {
                res.status(400).json({
                    message: "Invalid cursor."
                })
                return
            }

            filter._id = { $lt: new mongoose.Types.ObjectId(rawCursor) }
        }

        // Fetch one extra row to learn whether another page exists without a
        // second query. idempotencyKey and requestFingerprint are internal
        // and are deliberately excluded from the response.
        const transactions = await transactionModel
            .find(filter)
            .sort({ _id: -1 })
            .limit(limit + 1)
            .select(
                "_id type amount currency status description walletId senderWalletId receiverWalletId createdAt updatedAt"
            )
            .lean()

        const hasMore = transactions.length > limit
        const page = hasMore ? transactions.slice(0, limit) : transactions
        const nextCursor =
            hasMore && page.length > 0 ? String(page[page.length - 1]._id) : null

        res.status(200).json({
            message: "Transactions fetched successfully.",
            limit,
            nextCursor,
            transactions: page
        })

    } catch (error) {

        console.error("Get transactions error:", error)

        res.status(500).json({
            message: "Internal server error."
        })
    }
}
