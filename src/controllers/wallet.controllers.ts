import mongoose from "mongoose";
import { Request, Response } from "express"
import walletModel from "../models/wallet.models"
import transactionModel from "../models/transaction.models";
import { AuthRequest } from "../middleware/auth.middleware"
import ledgerModel from "../models/ledger.models"


// Largest single operation we accept, in paise (Rs 10,00,000). Keeping a hard
// cap stops Math.round(amount * 100) from overflowing to Infinity and keeps
// balances well inside Number.MAX_SAFE_INTEGER.
const MAX_TRANSACTION_AMOUNT_IN_PAISE = 100_000_000

// Direct wallet top-ups bypass Razorpay, so any logged-in user could mint
// money if this were always on. It stays available for local development but
// is force-disabled when NODE_ENV=production unless explicitly opted in.
// Real top-ups must go through the Razorpay create-order -> verify (or
// webhook) flow.
const directCreditEnabled =
    process.env.ALLOW_DIRECT_WALLET_CREDIT === "true" ||
    process.env.NODE_ENV !== "production"

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

    let session: mongoose.ClientSession | undefined

    // Read these before the try block so the duplicate-key recovery path in
    // catch can use them.
    const { amount } = req.body ?? {}
    const idempotencyKey = req.headers["idempotency-key"]
    const userId = req.user?.userId

    try {

        // Guard the insecure shortcut first: without this, any logged-in
        // user can credit their own wallet with any amount they like.
        if (!directCreditEnabled) {
            res.status(403).json({
                message:
                    "Direct wallet credit is disabled. Add money through the Razorpay order and verification flow."
            })
            return
        }

        if (!idempotencyKey || typeof idempotencyKey !== "string") {

            res.status(400).json({
                message: "Idempotency-Key header is required."
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

        session = await mongoose.startSession()

        session.startTransaction()

        // Find the caller's wallet first so the idempotency lookup can be
        // scoped to it. A key that belongs to another user's wallet must
        // never surface their transaction details.
        const wallet = await walletModel.findOne({
            ownerId: userId
        }).session(session)

        if (!wallet) {

            await session.abortTransaction()

            res.status(404).json({
                message: "Wallet not found."
            })

            return
        }

        // Check wallet status
        if (wallet.status !== "active") {

            await session.abortTransaction()

            res.status(400).json({
                message: "Wallet is not active."
            })

            return
        }

        // Replays return the original result instead of crediting twice.
        const existingTransaction = await transactionModel.findOne({
            idempotencyKey,
            walletId: wallet._id
        }).session(session)

        if (existingTransaction) {

            await session.abortTransaction()

            res.status(200).json({
                message: "Request already processed.",
                transaction: {
                    id: existingTransaction._id,
                    type: existingTransaction.type,
                    amount: existingTransaction.amount,
                    status: existingTransaction.status
                }
            })

            return
        }

        // Atomic credit. $inc avoids the lost-update race a read-modify-write
        // (wallet.balance += amount; wallet.save()) would have with a
        // concurrent credit or transfer.
        const updatedWallet = await walletModel.findOneAndUpdate(
            {
                _id: wallet._id,
                status: "active"
            },
            {
                $inc: { balance: amountInPaise }
            },
            { new: true, session }
        )

        if (!updatedWallet) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Wallet is not active."
            })

            return
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

        // Commit database transaction
        await session.commitTransaction()

        res.status(200).json({
            message: "Money added successfully.",
            wallet: {
                id: updatedWallet._id,
                balance: updatedWallet.balance,
                reservedBalance: updatedWallet.reservedBalance ?? 0,
                currency: updatedWallet.currency
            },
            transaction: {
                id: transaction._id,
                type: transaction.type,
                amount: transaction.amount,
                status: transaction.status
            }
        })

    } catch (error) {

        if (session?.inTransaction()) {
            await session.abortTransaction()
        }

        // Two identical requests can race past the pre-check above. The
        // unique index on Transaction.idempotencyKey then rejects one of
        // them. Return the winning transaction instead of a 500.
        if (isDuplicateKeyError(error)) {

            const wallet = userId
                ? await walletModel.findOne({ ownerId: userId })
                : null

            const existing = wallet
                ? await transactionModel.findOne({
                    idempotencyKey: String(idempotencyKey),
                    walletId: wallet._id
                })
                : null

            if (existing) {

                res.status(200).json({
                    message: "Request already processed.",
                    transaction: {
                        id: existing._id,
                        type: existing.type,
                        amount: existing.amount,
                        status: existing.status
                    }
                })

                return
            }

            res.status(409).json({
                message: "This Idempotency-Key has already been used."
            })

            return
        }

        console.log("Add money error:", error)

        res.status(500).json({
            message: "Internal server error."
        })

    } finally {

        await session?.endSession()

    }
}


export const transferMoney = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    let session: mongoose.ClientSession | undefined

    // Read these before the try block so the duplicate-key recovery path in
    // catch can use them.
    const { receiverId, amount } = req.body ?? {}
    const idempotencyKey = req.headers["idempotency-key"]
    const senderId = req.user?.userId

    try {

        if (!idempotencyKey || typeof idempotencyKey !== "string") {

            res.status(400).json({
                message: "Idempotency-Key header is required."
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

        session = await mongoose.startSession()

        session.startTransaction()

        // Find sender wallet
        const senderWallet = await walletModel.findOne({
            ownerId: senderId
        }).session(session)

        if (!senderWallet) {

            await session.abortTransaction()

            res.status(404).json({
                message: "Sender wallet not found."
            })

            return
        }

        // Find receiver wallet
        const receiverWallet = await walletModel.findOne({
            ownerId: receiverId
        }).session(session)

        if (!receiverWallet) {

            await session.abortTransaction()

            res.status(404).json({
                message: "Receiver wallet not found."
            })

            return
        }

        // Sender and receiver cannot be the same.
        // Compared as ObjectIds so casing/format differences on the
        // receiver id cannot bypass the check.
        if (String(senderWallet._id) === String(receiverWallet._id)) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Sender and receiver cannot be the same."
            })

            return
        }

        // Check wallet status
        if (
            senderWallet.status !== "active" ||
            receiverWallet.status !== "active"
        ) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Both wallets must be active."
            })

            return
        }

        // Both sides must settle in the same currency
        if (senderWallet.currency !== receiverWallet.currency) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Both wallets must use the same currency."
            })

            return
        }

        // Idempotency is scoped to the sender wallet so a key used by another
        // user can never expose their transfer, and replays return the
        // original result instead of failing on the balance check below.
        const existingTransaction = await transactionModel.findOne({
            idempotencyKey,
            senderWalletId: senderWallet._id
        }).session(session)

        if (existingTransaction) {

            await session.abortTransaction()

            res.status(200).json({
                message: "Request already processed.",
                transaction: {
                    id: existingTransaction._id,
                    type: existingTransaction.type,
                    amount: existingTransaction.amount,
                    status: existingTransaction.status
                }
            })

            return
        }

        // Atomic sender debit. The $expr guard checks the spendable balance
        // (balance minus reservedBalance) inside the database, so two
        // concurrent transfers can never both spend the same rupees, and
        // funds reserved for in-flight refunds stay locked.
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

            await session.abortTransaction()

            res.status(400).json({
                message: "Insufficient wallet balance."
            })

            return
        }

        // Atomic receiver credit. If it fails, throw so the whole transaction
        // (including the sender debit) is rolled back.
        const creditedReceiver = await walletModel.findOneAndUpdate(
            {
                _id: receiverWallet._id,
                status: "active"
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

        // Commit transaction
        await session.commitTransaction()

        res.status(200).json({
            message: "Money transferred successfully.",
            transfer: {
                transactionId: transaction._id,
                amount: transaction.amount,
                currency: transaction.currency,
                status: transaction.status
            },
            senderWallet: {
                id: debitedSender._id,
                balance: debitedSender.balance
            },
            receiverWallet: {
                id: creditedReceiver._id,
                balance: creditedReceiver.balance
            }
        })

    } catch (error) {

        if (session?.inTransaction()) {
            await session.abortTransaction()
        }

        // A concurrent duplicate can lose the race on the unique
        // Transaction.idempotencyKey index. Return the original transfer
        // instead of a 500 so retrying a request is always safe.
        if (isDuplicateKeyError(error)) {

            const senderWallet = senderId
                ? await walletModel.findOne({ ownerId: senderId })
                : null

            const existing = senderWallet
                ? await transactionModel.findOne({
                    idempotencyKey: String(idempotencyKey),
                    senderWalletId: senderWallet._id
                })
                : null

            if (existing) {

                res.status(200).json({
                    message: "Request already processed.",
                    transaction: {
                        id: existing._id,
                        type: existing.type,
                        amount: existing.amount,
                        status: existing.status
                    }
                })

                return
            }

            res.status(409).json({
                message: "This Idempotency-Key has already been used."
            })

            return
        }

        console.log("Transfer error:", error)

        res.status(500).json({
            message: "Internal server error."
        })

    } finally {

        await session?.endSession()

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

        // Find transactions related to this wallet
        const transactions = await transactionModel
            .find({
                $or: [
                    { walletId: wallet._id },
                    { senderWalletId: wallet._id },
                    { receiverWalletId: wallet._id }
                ]
            })
            .sort({ createdAt: -1 })
            .limit(limit)

        res.status(200).json({
            message: "Transactions fetched successfully.",
            limit,
            transactions
        })

    } catch (error) {

        console.error("Get transactions error:", error)

        res.status(500).json({
            message: "Internal server error."
        })
    }
}
