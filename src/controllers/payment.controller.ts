import { Request, Response } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";

import mongoose from "mongoose";

import Payment from "../models/payment.models";
import Wallet from "../models/wallet.models";
import Transaction from "../models/transaction.models";
import Ledger from "../models/ledger.models";
import { AuthRequest } from "../middleware/auth.middleware"
import PaymentOrder from "../models/payment-order.models"
import Refund from "../models/refund.models"
import type { IRefund, RefundStatus } from "../models/refund.models"
import type { Refunds } from "razorpay/dist/types/refunds";

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!
});

export const createOrder = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {
    try {
        const userId = req.user?.userId;
        const idempotencyKey = req.headers["idempotency-key"];
        const { amount } = req.body;

        // Check authenticated user
        if (!userId) {
            res.status(401).json({
                message: "User is not authenticated."
            });
            return;
        }

        // Validate amount
        if (
            typeof amount !== "number" ||
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            res.status(400).json({
                message: "Amount must be greater than 0."
            });
            return;
        }

        // Validate idempotency key
        if (!idempotencyKey || typeof idempotencyKey !== "string") {
            res.status(400).json({
                message: "Idempotency-Key header is required."
            });
            return;
        }

        // Convert INR to paise
        const amountInPaise = Math.round(amount * 100);

        if (amountInPaise < 1) {
            res.status(400).json({
                message: "Amount must be at least 1Rs."
            });
            return;
        }

        // Check if this request was already processed.
        // Scoped to the authenticated user so a shared or guessable key
        // cannot surface another user's order details.
        const existingPaymentOrder = await PaymentOrder.findOne({
            idempotencyKey,
            userId
        });

        if (existingPaymentOrder) {
            res.status(200).json({
                message: "Request already processed.",
                order: {
                    id: existingPaymentOrder.razorpayOrderId,
                    amount: existingPaymentOrder.amount,
                    currency: existingPaymentOrder.currency,
                    status: existingPaymentOrder.status
                }
            });
            return;
        }

        // Create order on Razorpay
        const order = await razorpay.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: `receipt_${idempotencyKey}`
        });

        // Save Razorpay order in our database
        const paymentOrder = new PaymentOrder({
            userId,
            razorpayOrderId: order.id,
            amount: amountInPaise,
            currency: "INR",
            idempotencyKey,
            status: "CREATED"
        });

        await paymentOrder.save();

        // Send order details to frontend
        res.status(201).json({
            message: "Razorpay order created successfully.",
            order: {
                id: order.id,
                amount: order.amount,
                currency: order.currency,
                status: order.status
            }
        });

    } catch (error) {
        console.error("Create Razorpay order error:", error);

        res.status(500).json({
            message: "Failed to create Razorpay order."
        });
    }
};


export const verifyPayment = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    let session: mongoose.ClientSession | undefined

    try {

        const userId = req.user?.userId;

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body;
        // 1. Check authenticated user
        if (!userId) {
            res.status(401).json({
                message: "User is not authenticated."
            });
            return;
        }

        // 2. Validate Razorpay response
        if (
            !razorpay_order_id ||
            !razorpay_payment_id ||
            !razorpay_signature
        ) {
            res.status(400).json({
                message: "Payment verification details are required."
            });
            return;
        }

        const secret = process.env.RAZORPAY_KEY_SECRET;

        if (!secret) {
            res.status(500).json({
                message: "Razorpay secret is not configured."
            });
            return;
        }

        // 3. Verify Razorpay signature

        const body =
            razorpay_order_id + "|" + razorpay_payment_id;

        const expectedSignature = crypto
            .createHmac("sha256", secret)
            .update(body)
            .digest("hex");

        const providedBuffer = Buffer.from(
            String(razorpay_signature)
        );

        const expectedBuffer = Buffer.from(expectedSignature);

        if (
            providedBuffer.length !== expectedBuffer.length ||
            !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
        ) {
            res.status(400).json({
                message: "Payment verification failed."
            });
            return;
        }

        // 4. Find our PaymentOrder

        const paymentOrder = await PaymentOrder.findOne({
            razorpayOrderId: razorpay_order_id
        });

        if (!paymentOrder) {
            res.status(404).json({
                message: "Payment order not found."
            });
            return;
        }

        // 5. Make sure this order belongs to this user

        if (paymentOrder.userId.toString() !== userId) {
            res.status(403).json({
                message: "This payment order does not belong to this user."
            });
            return;
        }

        // An order already marked FAILED must not be credited

        if (paymentOrder.status === "FAILED") {
            res.status(400).json({
                message: "Payment order has already failed."
            });
            return;
        }

        // 6. Check if already processed

        const existingPayment = await Payment.findOne({
            razorpayPaymentId: razorpay_payment_id
        });

        if (existingPayment) {
            res.status(200).json({
                message: "Payment has already been processed.",
                paymentId: existingPayment.razorpayPaymentId
            });
            return;
        }

        // 7. Get actual order details from Razorpay

        const razorpayOrder = await razorpay.orders.fetch(
            razorpay_order_id
        );

        // 8. Make sure the amount matches

        if (razorpayOrder.amount !== paymentOrder.amount) {
            res.status(400).json({
                message: "Payment amount does not match the order."
            });
            return;
        }

        // 9. Start MongoDB transaction

        session = await mongoose.startSession();

        const txSession = session;

        const outcome = await txSession.withTransaction(async () => {
            const existingPaymentInTransaction = await Payment.findOne({
                razorpayPaymentId: razorpay_payment_id
            }).session(txSession);

            if (existingPaymentInTransaction) {
                return {
                    kind: "already_processed" as const,
                    paymentId: existingPaymentInTransaction.razorpayPaymentId
                };
            }

            const existingTransactionInTransaction = await Transaction.findOne({
                idempotencyKey: paymentOrder.idempotencyKey
            }).session(txSession);

            if (existingTransactionInTransaction) {
                return {
                    kind: "already_processed" as const,
                    paymentId: razorpay_payment_id
                };
            }

            // Find user's wallet

            const wallet = await Wallet.findOne({
                ownerId: userId
            }).session(txSession);

            if (!wallet) {
                return { kind: "wallet_not_found" as const };
            }

            if (wallet.status !== "active") {
                return { kind: "wallet_inactive" as const };
            }

            // 10. Update wallet balance

            const updatedWallet = await Wallet.findOneAndUpdate(
                { _id: wallet._id, status: "active" },
                { $inc: { balance: paymentOrder.amount } },
                { new: true, runValidators: true, session: txSession }
            );

            if (!updatedWallet) {
                return { kind: "wallet_inactive" as const };
            }

            const balanceAfter = updatedWallet.balance;

            const balanceBefore = balanceAfter - paymentOrder.amount;

            // 11. Create Payment record

            const payment = new Payment({
                userId,
                razorpayOrderId: razorpay_order_id,
                razorpayPaymentId: razorpay_payment_id,
                razorpaySignature: razorpay_signature,
                amount: paymentOrder.amount,
                currency: paymentOrder.currency,
                status: "SUCCESS"
            });

            await payment.save({ session: txSession });

            // 12. Create wallet transaction

            const transaction = new Transaction({
                walletId: updatedWallet._id,
                type: "CREDIT",
                amount: paymentOrder.amount,
                currency: paymentOrder.currency,
                status: "Success",

                // Reuse the PaymentOrder idempotency key so this write is
                // deduped against the webhook credit path for the same order
                idempotencyKey: paymentOrder.idempotencyKey,

                description: "Money added through Razorpay"
            });

            await transaction.save({ session: txSession });

            // 13. Create ledger entry

            const ledger = new Ledger({
                walletId: updatedWallet._id,
                transactionId: transaction._id,
                type: "CREDIT",
                amount: paymentOrder.amount,
                balanceBefore,
                balanceAfter,
                currency: paymentOrder.currency,
                description: "Razorpay wallet recharge"
            });

            await ledger.save({ session: txSession });

            // 14. Update PaymentOrder

            paymentOrder.status = "PAID";
            paymentOrder.markModified("status");

            await paymentOrder.save({ session: txSession });

            return {
                kind: "created" as const,
                payment,
                wallet: updatedWallet
            };
        });

        if (outcome.kind === "wallet_not_found") {
            res.status(404).json({
                message: "Wallet not found."
            });
            return;
        }

        if (outcome.kind === "wallet_inactive") {
            res.status(400).json({
                message: "Wallet is not active."
            });
            return;
        }

        if (outcome.kind === "already_processed") {
            res.status(200).json({
                message: "Payment has already been processed.",
                paymentId: outcome.paymentId
            });
            return;
        }

        res.status(200).json({
            message: "Payment verified and wallet credited successfully.",
            payment: {
                paymentId: outcome.payment.razorpayPaymentId,
                orderId: outcome.payment.razorpayOrderId,
                amount: outcome.payment.amount,
                currency: outcome.payment.currency
            },
            wallet: {
                balance: outcome.wallet.balance,
                currency: outcome.wallet.currency
            }
        });

    } catch (error) {

        if (session?.inTransaction()) {
            await session.abortTransaction();
        }

        if (isDuplicateKeyError(error)) {
            res.status(200).json({
                message: "Payment has already been processed."
            });
            return;
        }

        console.error("Payment verification error:", error);

        res.status(500).json({
            message: "Payment verification failed."
        });

    } finally {
        await session?.endSession();
    }
};


export const handleWebhook = async (
    req: Request,
    res: Response
): Promise<void> => {

    let session: mongoose.ClientSession | undefined

    try {

        // 1. Get webhook secret

        const webhookSecret =
            process.env.RAZORPAY_WEBHOOK_SECRET;

        if (!webhookSecret) {
            res.status(500).json({
                message: "Razorpay webhook secret is not configured."
            });
            return;
        }

        // 2. Get Razorpay signature

        const razorpaySignature =
            req.headers["x-razorpay-signature"];

        if (!razorpaySignature || typeof razorpaySignature !== "string") {
            res.status(400).json({
                message: "Webhook signature is missing."
            });
            return;
        }

        // 3. Get raw request body

        const rawBody = (req as any).rawBody;

        if (!rawBody) {
            res.status(400).json({
                message: "Raw webhook body is missing."
            });
            return;
        }

        // 4. Generate expected signature

        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(rawBody)
            .digest("hex");

        // 5. Verify webhook signature

        const providedBuffer = Buffer.from(razorpaySignature);

        const expectedBuffer = Buffer.from(expectedSignature);

        if (
            providedBuffer.length !== expectedBuffer.length ||
            !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
        ) {
            res.status(400).json({
                message: "Invalid webhook signature."
            });
            return;
        }

        // Webhook is authentic

        const event = req.body.event;

        console.log(
            "Razorpay webhook received:",
            event
        );

        // =====================================================
        // PAYMENT CAPTURED
        // =====================================================

        if (event === "payment.captured") {

            const paymentEntity =
                req.body.payload?.payment?.entity;

            if (!paymentEntity) {
                res.status(400).json({
                    message: "Payment data is missing."
                });
                return;
            }

            const razorpayPaymentId = paymentEntity.id;

            const razorpayOrderId = paymentEntity.order_id;

            const amount = paymentEntity.amount;

            const currency = paymentEntity.currency;

            // 6. Find our PaymentOrder

            const paymentOrder =
                await PaymentOrder.findOne({
                    razorpayOrderId
                });

            if (!paymentOrder) {
                res.status(404).json({
                    message: "Payment order not found."
                });
                return;
            }

            // 7. Verify amount

            if (paymentOrder.amount !== amount) {
                res.status(400).json({
                    message: "Payment amount does not match the order."
                });
                return;
            }

            // 8. Verify currency

            if (paymentOrder.currency !== currency) {
                res.status(400).json({
                    message: "Payment currency does not match the order."
                });
                return;
            }

            // 9. Check if this payment was already processed

            const existingPayment =
                await Payment.findOne({
                    razorpayPaymentId
                });

            if (existingPayment) {

                res.status(200).json({
                    message: "Payment already processed."
                });

                return;
            }

            // =================================================
            // START MONGODB TRANSACTION
            // =================================================

            session = await mongoose.startSession();

            const txSession = session;

            const outcome = await txSession.withTransaction(async () => {
                // 10. Re-check inside transaction
                // Protects against simultaneous webhook requests

                const existingPaymentInTransaction =
                    await Payment.findOne({
                        razorpayPaymentId
                    }).session(txSession);

                if (existingPaymentInTransaction) {
                    return { kind: "already_processed" as const };
                }

                const existingTransaction =
                    await Transaction.findOne({ idempotencyKey: paymentOrder.idempotencyKey }).session(txSession);

                if (existingTransaction) {
                    return { kind: "already_processed" as const };
                }

                // 11. Find user's wallet

                const wallet = await Wallet.findOne({ ownerId: paymentOrder.userId }).session(txSession);

                if (!wallet) {
                    return { kind: "wallet_not_found" as const };
                }

                // 12. Check wallet status

                if (wallet.status !== "active") {
                    return { kind: "wallet_inactive" as const };
                }

                // 13. Credit wallet and store post-update balances

                const updatedWallet = await Wallet.findOneAndUpdate(
                    { _id: wallet._id, status: "active" },
                    { $inc: { balance: paymentOrder.amount } },
                    { new: true, runValidators: true, session: txSession }
                );

                if (!updatedWallet) {
                    return { kind: "wallet_inactive" as const };
                }

                // 14. Store balances for the ledger entry

                const balanceAfter = updatedWallet.balance;

                const balanceBefore = balanceAfter - paymentOrder.amount;

                // 15. Create Payment

                const payment = new Payment({
                    userId: paymentOrder.userId,
                    razorpayOrderId,
                    razorpayPaymentId,
                    // NOTE: the x-razorpay-signature header is a WEBHOOK
                    // signature (HMAC of the raw body). It is not the Razorpay
                    // Checkout signature, so it is deliberately NOT stored in
                    // razorpaySignature. That field is left empty for payments
                    // first seen through a webhook.
                    amount: paymentOrder.amount,
                    currency: paymentOrder.currency,
                    status: "SUCCESS"
                });

                await payment.save({ session: txSession });

                // 16. Create Transaction

                const transaction = new Transaction({
                    walletId: updatedWallet._id,
                    type: "CREDIT",
                    amount: paymentOrder.amount,
                    currency: paymentOrder.currency,
                    status: "Success",

                    // IMPORTANT:
                    // Reuse the idempotency key
                    // from PaymentOrder

                    idempotencyKey: paymentOrder.idempotencyKey,

                    description: "Money added through Razorpay webhook"
                });

                await transaction.save({
                    session: txSession
                });

                // 17. Create Ledger

                const ledger = new Ledger({
                    walletId: updatedWallet._id,
                    transactionId: transaction._id,
                    type: "CREDIT",
                    amount: paymentOrder.amount,
                    balanceBefore,
                    balanceAfter,
                    currency: paymentOrder.currency,
                    description:
                        "Razorpay wallet recharge"
                });

                await ledger.save({
                    session: txSession
                });

                // 18. Mark PaymentOrder as PAID

                paymentOrder.status = "PAID";
                paymentOrder.markModified("status");

                await paymentOrder.save({
                    session: txSession
                });

                return { kind: "created" as const };
            });

            if (outcome.kind === "already_processed") {
                res.status(200).json({
                    message: "Payment already processed."
                });
                return;
            }

            if (outcome.kind === "wallet_not_found") {
                res.status(404).json({
                    message: "Wallet not found."
                });
                return;
            }

            if (outcome.kind === "wallet_inactive") {
                res.status(400).json({
                    message: "Wallet is not active."
                });
                return;
            }

            console.log(
                "Wallet credited successfully:",
                razorpayPaymentId
            );

            res.status(200).json({
                message:
                    "Payment captured and wallet credited successfully."
            });

            return;
        }

        // =====================================================
        // PAYMENT FAILED
        // =====================================================

        if (event === "payment.failed") {

            const paymentEntity =
                req.body.payload?.payment?.entity;

            if (!paymentEntity) {
                res.status(400).json({
                    message: "Payment data is missing."
                });
                return;
            }

            const razorpayOrderId =
                paymentEntity.order_id;

            console.log(
                "Razorpay payment failed:",
                paymentEntity.id
            );

            // Find our PaymentOrder

            await PaymentOrder.findOneAndUpdate(
                { razorpayOrderId, status: "CREATED" },
                { $set: { status: "FAILED" } }
            );

            res.status(200).json({
                message: "Payment failure webhook processed."
            });

            return;
        }

        // =====================================================
        // REFUND EVENTS
        //
        // A refund created by createRefund may still be PENDING at
        // Razorpay. These events move it to its final state:
        //   - refund.processed -> debit the wallet and finalize
        //   - refund.failed    -> release the reservation
        //
        // finalizeRefund() only ever debits once, because the refund
        // status transition is guarded and all writes share one
        // transaction. So a duplicate webhook cannot double-debit.
        // =====================================================

        if (event === "refund.processed" || event === "refund.failed") {

            const refundEntity =
                req.body.payload?.refund?.entity;

            if (!refundEntity || !refundEntity.id) {
                res.status(400).json({
                    message: "Refund data is missing."
                });
                return;
            }

            let refund = await Refund.findOne({
                razorpayRefundId: refundEntity.id
            });

            // Fall back to our own receipt (the idempotency key) in case
            // the refund id was never stored locally.
            if (!refund && refundEntity.receipt) {
                refund = await Refund.findOne({
                    idempotencyKey: refundEntity.receipt
                });

                if (refund) {
                    await Refund.updateOne(
                        { _id: refund._id },
                        { $set: { razorpayRefundId: refundEntity.id } }
                    );
                }
            }

            if (!refund) {
                // We never heard of this refund. Acknowledge so Razorpay
                // stops retrying.
                res.status(200).json({
                    message: "Refund not found; ignored."
                });
                return;
            }

            if (event === "refund.processed") {
                await finalizeRefund(String(refund._id));
                res.status(200).json({
                    message: "Refund processed webhook handled."
                });
                return;
            }

            await releaseRefundReservation(
                String(refund._id),
                "Razorpay reported the refund as failed (webhook)."
            );

            res.status(200).json({
                message: "Refund failed webhook handled."
            });
            return;
        }

        // =====================================================
        // OTHER EVENTS
        // =====================================================

        res.status(200).json({
            message: "Webhook received successfully."
        });

    } catch (error) {

        // Rollback if transaction was started

        if (session?.inTransaction()) {
            await session.abortTransaction();
        }

        // A duplicate delivery can lose the race against a unique index
        // (Payment.razorpayPaymentId or Transaction.idempotencyKey). The
        // credit already happened, so acknowledge the webhook instead of
        // returning 500 and making Razorpay retry it.
        if (isDuplicateKeyError(error)) {
            res.status(200).json({
                message: "Webhook already processed."
            });
            return;
        }

        console.error(
            "Razorpay webhook error:",
            error
        );

        res.status(500).json({
            message: "Webhook processing failed."
        });

    } finally {

        await session?.endSession();
    }
};


export const getPaymentStatus = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {
    try {
        // 1. Get authenticated user
        const userId = req.user?.userId;

        if (!userId) {
            res.status(401).json({
                message: "User is not authenticated."
            });
            return;
        }

        // 2. Get Razorpay order ID from URL
        const { orderId } = req.params;

        if (!orderId) {
            res.status(400).json({
                message: "Order ID is required."
            });
            return;
        }

        // 3. Find payment order
        const paymentOrder = await PaymentOrder.findOne({
            razorpayOrderId: orderId,
            userId
        });

        if (!paymentOrder) {
            res.status(404).json({
                message: "Payment order not found."
            });
            return;
        }

        // 4. Return payment status
        res.status(200).json({
            message: "Payment status fetched successfully.",
            payment: {
                orderId: paymentOrder.razorpayOrderId,
                amount: paymentOrder.amount,
                currency: paymentOrder.currency,
                status: paymentOrder.status,
                createdAt: paymentOrder.createdAt,
                updatedAt: paymentOrder.updatedAt
            }
        });

    } catch (error) {
        console.error(
            "Get payment status error:",
            error
        );

        res.status(500).json({
            message: "Failed to fetch payment status."
        });
    }
};


// ---------------------------------------------------------------------------
// Refund helpers
// ---------------------------------------------------------------------------

// Razorpay uses lowercase refund statuses. Anything we do not positively
// recognise is treated as PENDING, never as PROCESSED or FAILED.
function mapRazorpayRefundStatus(status: string): RefundStatus {
    if (status === "processed") {
        return "PROCESSED";
    }

    if (status === "failed") {
        return "FAILED";
    }

    return "PENDING";
}

// Razorpay's SDK rejects with `{ statusCode, error }` for HTTP errors, but a
// network timeout rejects with a different error that has no statusCode. Only
// a 4xx is a definitive rejection. Everything else (5xx, timeout, unknown) is
// treated as an unknown outcome that must not be assumed to have failed.
function getRazorpayStatusCode(error: unknown): number | undefined {
    if (error && typeof error === "object" && "statusCode" in error) {
        const code = Number((error as { statusCode?: unknown }).statusCode);
        return Number.isFinite(code) ? code : undefined;
    }

    return undefined;
}

function isDuplicateKeyError(error: unknown): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === 11000
    );
}

function serializeRefund(refund: IRefund) {
    return {
        id: refund._id,
        razorpayRefundId: refund.razorpayRefundId,
        paymentId: refund.paymentId,
        razorpayPaymentId: refund.razorpayPaymentId,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status,
        requiresReconciliation: refund.requiresReconciliation,
        failureReason: refund.failureReason,
        createdAt: refund.createdAt,
        finalizedAt: refund.finalizedAt
    };
}

// Claims the idempotency key by inserting the refund row BEFORE Razorpay is
// called. The unique index on `idempotencyKey` is what guarantees that only
// one request can ever reach Razorpay for a given key. The loser of the race
// gets E11000 and is answered with the existing row.
type ClaimResult =
    | { kind: "created"; refund: IRefund }
    | { kind: "existing"; refund: IRefund };

async function claimRefundKey(details: {
    userId: string;
    paymentId: mongoose.Types.ObjectId;
    razorpayPaymentId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    reason?: string;
}): Promise<ClaimResult> {

    try {
        const created = await Refund.create({
            userId: details.userId,
            paymentId: details.paymentId,
            razorpayPaymentId: details.razorpayPaymentId,
            amount: details.amount,
            currency: details.currency,
            status: "CREATED",
            reservationActive: false,
            requiresReconciliation: false,
            idempotencyKey: details.idempotencyKey,
            reason: details.reason
        });

        return { kind: "created", refund: created };

    } catch (error) {

        if (!isDuplicateKeyError(error)) {
            throw error;
        }

        const existing = await Refund.findOne({
            idempotencyKey: details.idempotencyKey
        });

        if (!existing) {
            // The unique index rejected the insert but the row is not
            // readable yet (a concurrent insert is still committing).
            // Ask the caller to retry.
            throw error;
        }

        return { kind: "existing", refund: existing };
    }
}

// Finalizes a refund that Razorpay has confirmed as processed.
//
// The status transition CREATED/PENDING -> PROCESSED is the lock that stops
// the same refund from being finalized twice (for example by the HTTP request
// and a webhook at the same time). Every money movement happens in ONE MongoDB
// transaction, so the wallet debit, the payment totals, the DEBIT transaction
// and the DEBIT ledger entry are committed together or not at all.
//
// Returns the refund's status after the attempt.
async function finalizeRefund(refundId: string): Promise<RefundStatus> {

    let session: mongoose.ClientSession | undefined;

    try {
        session = await mongoose.startSession();
        session.startTransaction();

        // 1. Claim the finalization. Only a reserved refund can be claimed,
        //    and only once.
        const refund = await Refund.findOneAndUpdate(
            {
                _id: refundId,
                status: { $in: ["CREATED", "PENDING"] },
                reservationActive: true
            },
            {
                $set: {
                    status: "PROCESSED",
                    reservationActive: false,
                    requiresReconciliation: false,
                    finalizedAt: new Date()
                }
            },
            { new: true, session }
        );

        if (!refund) {
            // Already finalized, or the reservation is not active yet.
            if (session.inTransaction()) {
                await session.abortTransaction();
            }

            const current = await Refund.findById(refundId);
            return current?.status ?? "FAILED";
        }

        // 2. Move the reserved wallet funds out of the wallet.
        //    The $expr guard proves the reservation really exists, so this
        //    can never overdraw the wallet or debit an unreserved refund.
        const wallet = await Wallet.findOneAndUpdate(
            {
                ownerId: refund.userId,
                $expr: {
                    $and: [
                        { $gte: [{ $ifNull: ["$reservedBalance", 0] }, refund.amount] },
                        { $gte: ["$balance", refund.amount] }
                    ]
                }
            },
            {
                $inc: {
                    balance: -refund.amount,
                    reservedBalance: -refund.amount
                }
            },
            { new: true, session }
        );

        if (!wallet) {
            throw new Error("Wallet reservation is missing during refund finalization.");
        }

        // 3. Move the reserved capacity into the completed refund total.
        const payment = await Payment.findOneAndUpdate(
            {
                _id: refund.paymentId,
                $expr: {
                    $gte: [
                        { $ifNull: ["$reservedRefundAmount", 0] },
                        refund.amount
                    ]
                }
            },
            {
                $inc: {
                    reservedRefundAmount: -refund.amount,
                    refundedAmount: refund.amount
                }
            },
            { new: true, session }
        );

        if (!payment) {
            throw new Error("Payment reservation is missing during refund finalization.");
        }

        // 4. Exactly one DEBIT transaction. Reusing the refund's idempotency
        //    key means a retry cannot create a second one.
        const transaction = new Transaction({
            walletId: wallet._id,
            type: "DEBIT",
            amount: refund.amount,
            currency: refund.currency,
            status: "Success",
            idempotencyKey: refund.idempotencyKey,
            description: "Refund for Razorpay payment"
        });

        await transaction.save({ session });

        // 5. Exactly one DEBIT ledger entry.
        const ledger = new Ledger({
            walletId: wallet._id,
            transactionId: transaction._id,
            type: "DEBIT",
            amount: refund.amount,
            balanceBefore: wallet.balance + refund.amount,
            balanceAfter: wallet.balance,
            currency: refund.currency,
            description: "Razorpay payment refund"
        });

        await ledger.save({ session });

        await session.commitTransaction();

        return "PROCESSED";

    } catch (error) {

        if (session?.inTransaction()) {
            await session.abortTransaction();
        }

        console.error("Refund finalization failed:", { refundId, error });

        // Razorpay has refunded the customer but our accounting did not
        // complete. Keep the reservation and flag the row for reconciliation.
        // Do NOT count it as completed.
        try {
            await Refund.updateOne(
                { _id: refundId, status: { $ne: "PROCESSED" } },
                {
                    $set: {
                        status: "PENDING",
                        requiresReconciliation: true,
                        failureReason:
                            "Wallet accounting failed after the Razorpay refund."
                    }
                }
            );
        } catch (updateError) {
            console.error(
                "CRITICAL: could not flag refund for reconciliation. " +
                "Trace it with the refund id in the logs.",
                { refundId, updateError }
            );
        }

        const current = await Refund.findById(refundId);
        return current?.status ?? "PENDING";

    } finally {
        await session?.endSession();
    }
}

// Releases a reservation WITHOUT debiting the wallet. Used when a refund is
// definitively not going to happen, so the held capacity and funds must be
// given back.
async function releaseRefundReservation(
    refundId: string,
    failureReason: string
): Promise<RefundStatus> {

    let session: mongoose.ClientSession | undefined;

    try {
        session = await mongoose.startSession();
        session.startTransaction();

        const refund = await Refund.findOneAndUpdate(
            { _id: refundId, status: { $in: ["CREATED", "PENDING"] } },
            {
                $set: {
                    status: "FAILED",
                    requiresReconciliation: false,
                    failureReason,
                    finalizedAt: new Date()
                }
            },
            { new: true, session }
        );

        if (!refund) {
            if (session.inTransaction()) {
                await session.abortTransaction();
            }

            const current = await Refund.findById(refundId);
            return current?.status ?? "FAILED";
        }

        // Only give back what was actually reserved.
        if (refund.reservationActive) {
            const paymentResult = await Payment.updateOne(
                {
                    _id: refund.paymentId,
                    $expr: {
                        $gte: [
                            { $ifNull: ["$reservedRefundAmount", 0] },
                            refund.amount
                        ]
                    }
                },
                { $inc: { reservedRefundAmount: -refund.amount } },
                { session }
            );

            const walletResult = await Wallet.updateOne(
                {
                    ownerId: refund.userId,
                    $expr: {
                        $gte: [
                            { $ifNull: ["$reservedBalance", 0] },
                            refund.amount
                        ]
                    }
                },
                { $inc: { reservedBalance: -refund.amount } },
                { session }
            );

            // If either guarded decrement matched nothing, the stored
            // counters and the refund row disagree. Abort instead of
            // marking the refund FAILED while funds may still be held.
            if (
                paymentResult.matchedCount === 0 ||
                walletResult.matchedCount === 0
            ) {
                throw new Error(
                    "Refund reservation counters are inconsistent."
                );
            }

            await Refund.updateOne(
                { _id: refund._id },
                { $set: { reservationActive: false } },
                { session }
            );
        }

        await session.commitTransaction();

        return "FAILED";

    } catch (error) {

        if (session?.inTransaction()) {
            await session.abortTransaction();
        }

        console.error("Refund release failed:", { refundId, error });

        // We could not safely give the reservation back. Keep the row
        // PENDING and flag it, rather than pretending it failed while funds
        // are still held.
        try {
            await Refund.updateOne(
                { _id: refundId, status: { $ne: "PROCESSED" } },
                {
                    $set: {
                        status: "PENDING",
                        requiresReconciliation: true,
                        failureReason: "Could not release the refund reservation."
                    }
                }
            );
        } catch (updateError) {
            console.error(
                "CRITICAL: could not flag refund for reconciliation.",
                { refundId, updateError }
            );
        }

        return "PENDING";

    } finally {
        await session?.endSession();
    }
}

// Builds the response for a refund that has just been handled, so every
// code path returns the same shape.
async function respondWithRefundResult(
    res: Response,
    refundId: string,
    status: RefundStatus
): Promise<void> {

    const refund = await Refund.findById(refundId);

    if (!refund) {
        res.status(500).json({
            message: "Failed to process the refund."
        });
        return;
    }

    if (status === "PROCESSED") {
        const wallet = await Wallet.findOne({ ownerId: refund.userId });
        const payment = await Payment.findById(refund.paymentId);

        res.status(200).json({
            message: "Refund processed successfully.",
            refund: serializeRefund(refund),
            wallet: wallet ? {
                id: wallet._id,
                balance: wallet.balance,
                currency: wallet.currency
            } : undefined,
            payment: payment ? {
                amount: payment.amount,
                refundedAmount: payment.refundedAmount ?? 0,
                reservedRefundAmount: payment.reservedRefundAmount ?? 0,
                refundableAmount:
                    payment.amount
                    - (payment.refundedAmount ?? 0)
                    - (payment.reservedRefundAmount ?? 0)
            } : undefined
        });
        return;
    }

    if (status === "CREATED" || status === "PENDING") {
        res.status(202).json({
            message: "Refund is pending confirmation from Razorpay.",
            refund: serializeRefund(refund),
            requiresReconciliation: refund.requiresReconciliation
        });
        return;
    }

    res.status(200).json({
        message: "Refund failed.",
        refund: serializeRefund(refund)
    });
}

// =============================================================
// CREATE REFUND
//
// Flow (Razorpay is never inside a MongoDB transaction):
//   1. Validate input.
//   2. Claim the idempotency key by inserting the Refund row (unique index).
//   3. Reserve refund capacity on the Payment and funds on the Wallet,
//      atomically, BEFORE calling Razorpay.
//   4. Call Razorpay.
//   5. Act on the confirmed status:
//        processed -> finalize (debit wallet, one transaction + one ledger)
//        pending   -> keep PENDING, no debit yet
//        failed    -> release reservation, no debit
// =============================================================
export const createRefund = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    const userId = req.user?.userId;

    const { paymentId, amount, reason } = req.body;

    const rawIdempotencyKey = req.headers["idempotency-key"];

    let session: mongoose.ClientSession | undefined;

    try {

        // 1. Validate the request.

        if (!userId) {
            res.status(401).json({
                message: "User is not authenticated."
            });
            return;
        }

        if (!rawIdempotencyKey || typeof rawIdempotencyKey !== "string") {
            res.status(400).json({
                message: "Idempotency-Key header is required."
            });
            return;
        }

        const idempotencyKey = rawIdempotencyKey;

        if (!paymentId || !mongoose.isValidObjectId(paymentId)) {
            res.status(400).json({
                message: "A valid paymentId is required."
            });
            return;
        }

        // FIX: the original check was missing the "!" before
        // Number.isFinite, so every finite amount was rejected.
        if (
            typeof amount !== "number" ||
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            res.status(400).json({
                message: "Amount must be greater than 0."
            });
            return;
        }

        // The frontend sends RUPEES; we store PAISE.
        const refundAmountInPaise = Math.round(amount * 100);

        if (refundAmountInPaise < 1) {
            res.status(400).json({
                message: "Amount must be at least 0.01."
            });
            return;
        }

        // 2. Load and authorise the payment. Its stored amount is the source
        //    of truth; the client's amount is never trusted.

        const payment = await Payment.findById(paymentId);

        if (!payment) {
            res.status(404).json({
                message: "Payment not found."
            });
            return;
        }

        if (payment.userId.toString() !== userId) {
            res.status(403).json({
                message: "This payment does not belong to you."
            });
            return;
        }

        if (payment.status !== "SUCCESS") {
            res.status(400).json({
                message: "Only a successful payment can be refunded."
            });
            return;
        }

        // Friendly pre-check. Not authoritative; step 3 is the real guard.
        const alreadyRefunded = payment.refundedAmount ?? 0;
        const alreadyReserved = payment.reservedRefundAmount ?? 0;
        const refundableAmount = payment.amount - alreadyRefunded - alreadyReserved;

        if (refundAmountInPaise > refundableAmount) {
            res.status(409).json({
                message: "Refund exceeds the remaining refundable amount.",
                paymentAmount: payment.amount,
                alreadyRefunded,
                alreadyReserved,
                refundableAmount
            });
            return;
        }

        // 3. Claim the idempotency key BEFORE any external call.
        const claim = await claimRefundKey({
            userId,
            paymentId: payment._id,
            razorpayPaymentId: payment.razorpayPaymentId,
            amount: refundAmountInPaise,
            currency: payment.currency,
            idempotencyKey,
            reason
        });

        if (claim.kind === "existing") {
            const existing = claim.refund;

            // Never expose another user's refund just because they guessed
            // the same idempotency key.
            if (existing.userId.toString() !== userId) {
                res.status(409).json({
                    message: "Idempotency-Key has already been used."
                });
                return;
            }

            const inProgress =
                existing.status === "CREATED" || existing.status === "PENDING";

            res.status(inProgress ? 202 : 200).json({
                message: inProgress
                    ? "Refund is still being processed."
                    : "Request already processed.",
                refund: serializeRefund(existing)
            });
            return;
        }

        const refund = claim.refund;

        // 4. Reserve capacity and wallet funds atomically.

        session = await mongoose.startSession();
        session.startTransaction();

        // FIX: the original $expr compared a one-element $lte array (there
        // was no right-hand side). This version compares
        // refundedAmount + reservedRefundAmount + newAmount <= amount, with
        // $ifNull so older payments that predate these fields still work.
        const reservedPayment = await Payment.findOneAndUpdate(
            {
                _id: payment._id,
                userId: payment.userId,
                status: "SUCCESS",
                $expr: {
                    $lte: [
                        {
                            $add: [
                                { $ifNull: ["$refundedAmount", 0] },
                                { $ifNull: ["$reservedRefundAmount", 0] },
                                refundAmountInPaise
                            ]
                        },
                        "$amount"
                    ]
                }
            },
            { $inc: { reservedRefundAmount: refundAmountInPaise } },
            { new: true, session }
        );

        if (!reservedPayment) {
            await session.abortTransaction();

            await Refund.updateOne(
                { _id: refund._id },
                {
                    $set: {
                        status: "FAILED",
                        failureReason:
                            "Refund exceeds the remaining refundable amount."
                    }
                }
            );

            res.status(409).json({
                message: "Refund exceeds the remaining refundable amount."
            });
            return;
        }

        // Reserve the wallet funds. Spendable balance is
        // balance - reservedBalance, so concurrent refunds cannot both
        // reserve the same rupees.
        const reservedWallet = await Wallet.findOneAndUpdate(
            {
                ownerId: userId,
                status: "active",
                $expr: {
                    $gte: [
                        {
                            $subtract: [
                                "$balance",
                                { $ifNull: ["$reservedBalance", 0] }
                            ]
                        },
                        refundAmountInPaise
                    ]
                }
            },
            { $inc: { reservedBalance: refundAmountInPaise } },
            { new: true, session }
        );

        if (!reservedWallet) {
            await session.abortTransaction();

            await Refund.updateOne(
                { _id: refund._id },
                {
                    $set: {
                        status: "FAILED",
                        failureReason:
                            "Wallet is inactive or has insufficient available balance."
                    }
                }
            );

            res.status(400).json({
                message:
                    "Wallet is not active or does not have enough available balance."
            });
            return;
        }

        await Refund.updateOne(
            { _id: refund._id },
            { $set: { reservationActive: true } },
            { session }
        );

        await session.commitTransaction();
        await session.endSession();
        session = undefined;

        // 5. Call Razorpay OUTSIDE any transaction. A MongoDB rollback can
        //    never undo an external refund, so the two systems are kept
        //    separate on purpose.

        let razorpayRefund: Refunds.RazorpayRefund;

        try {
            razorpayRefund = await razorpay.payments.refund(
                payment.razorpayPaymentId,
                {
                    amount: refundAmountInPaise,
                    // receipt lets us find this refund again during
                    // reconciliation even if we lose the refund id.
                    receipt: idempotencyKey
                }
            );
        } catch (razorpayError) {

            const statusCode = getRazorpayStatusCode(razorpayError);

            console.error("Razorpay refund API call failed:", {
                refundId: String(refund._id),
                statusCode,
                error: razorpayError
            });

            if (
                statusCode !== undefined &&
                statusCode >= 400 &&
                statusCode < 500
            ) {
                // Scenario A: Razorpay definitively rejected it.
                // Release the reservation; never debit the wallet.
                await releaseRefundReservation(
                    String(refund._id),
                    "Razorpay rejected the refund."
                );

                res.status(502).json({
                    message: "Refund was rejected by Razorpay.",
                    refund: {
                        id: refund._id,
                        status: "FAILED"
                    }
                });
                return;
            }

            // Scenario C: timeout or unknown outcome. Do NOT assume it
            // failed and do NOT issue another refund. Keep the reservation
            // and leave the row PENDING for reconciliation.
            await Refund.updateOne(
                { _id: refund._id, status: { $ne: "PROCESSED" } },
                {
                    $set: {
                        status: "PENDING",
                        requiresReconciliation: true,
                        failureReason:
                            "Razorpay refund outcome is unknown (timeout or server error)."
                    }
                }
            );

            res.status(202).json({
                message:
                    "Refund outcome is pending confirmation with Razorpay.",
                refund: {
                    id: refund._id,
                    status: "PENDING"
                },
                requiresReconciliation: true
            });
            return;
        }

        // Razorpay created the refund. Store its id immediately, OUTSIDE the
        // finalization transaction, so it can never be lost if finalization
        // fails (Scenario B). The id is always stored, but the status only
        // changes while the refund is still non-final: a refund.processed
        // webhook can arrive before this line runs, and it must never be
        // downgraded back to PENDING.
        try {
            await Refund.updateOne(
                { _id: refund._id },
                { $set: { razorpayRefundId: razorpayRefund.id } }
            );

            await Refund.updateOne(
                { _id: refund._id, status: { $in: ["CREATED", "PENDING"] } },
                { $set: { status: "PENDING" } }
            );
        } catch (saveError) {
            console.error(
                "CRITICAL: Razorpay refund created but its id could not be " +
                "stored. Reconciliation will need this log line.",
                {
                    refundId: String(refund._id),
                    razorpayRefundId: razorpayRefund.id,
                    error: saveError
                }
            );
        }

        const mappedStatus = mapRazorpayRefundStatus(razorpayRefund.status);

        if (mappedStatus === "FAILED") {
            const finalStatus = await releaseRefundReservation(
                String(refund._id),
                "Razorpay reported the refund as failed."
            );

            res.status(200).json({
                message: "Refund failed at Razorpay.",
                refund: {
                    id: refund._id,
                    razorpayRefundId: razorpayRefund.id,
                    status: finalStatus
                }
            });
            return;
        }

        if (mappedStatus === "PENDING") {
            // Accepted but not completed. No wallet debit until Razorpay
            // confirms it, so it is never reported as completed.
            res.status(202).json({
                message: "Refund is pending confirmation from Razorpay.",
                refund: {
                    id: refund._id,
                    razorpayRefundId: razorpayRefund.id,
                    status: "PENDING",
                    amount: refundAmountInPaise,
                    currency: payment.currency
                }
            });
            return;
        }

        // mappedStatus === "PROCESSED": finalize now.
        const finalStatus = await finalizeRefund(String(refund._id));

        await respondWithRefundResult(res, String(refund._id), finalStatus);
        return;

    } catch (error) {

        if (session?.inTransaction()) {
            await session.abortTransaction();
        }

        console.error("Create refund error:", error);

        res.status(500).json({
            message: "Failed to process the refund."
        });

    } finally {
        await session?.endSession();
    }
};

// =============================================================
// RECONCILE REFUND
//
// A safe, explicit way to resolve a refund whose real state is unknown
// (PENDING or requiresReconciliation). It asks Razorpay for the truth and
// then finalizes or releases the local reservation accordingly. It never
// issues a new refund.
// =============================================================
export const reconcileRefund = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    const userId = req.user?.userId;
    const { refundId } = req.params;

    try {

        if (!userId) {
            res.status(401).json({
                message: "User is not authenticated."
            });
            return;
        }

        if (!refundId || !mongoose.isValidObjectId(refundId)) {
            res.status(400).json({
                message: "A valid refundId is required."
            });
            return;
        }

        const refund = await Refund.findOne({
            _id: refundId,
            userId
        });

        if (!refund) {
            res.status(404).json({
                message: "Refund not found."
            });
            return;
        }

        // Nothing to reconcile for a terminal refund.
        if (refund.status === "PROCESSED" || refund.status === "FAILED") {
            res.status(200).json({
                message: "Refund is already final.",
                refund: serializeRefund(refund)
            });
            return;
        }

        // Ask Razorpay for the current state.
        let razorpayRefund: Refunds.RazorpayRefund | undefined;

        try {
            if (refund.razorpayRefundId) {
                razorpayRefund = await razorpay.refunds.fetch(
                    refund.razorpayRefundId
                );
            } else {
                // We never stored the refund id. Look through the payment's
                // refunds for the one carrying our receipt (idempotency key).
                const refunds = await razorpay.payments.fetchMultipleRefund(
                    refund.razorpayPaymentId,
                    { count: 100 }
                );

                razorpayRefund = refunds.items.find(
                    (item) => item.receipt === refund.idempotencyKey
                ) as Refunds.RazorpayRefund | undefined;

                if (razorpayRefund) {
                    await Refund.updateOne(
                        { _id: refund._id },
                        { $set: { razorpayRefundId: razorpayRefund.id } }
                    );
                }
            }
        } catch (fetchError) {
            console.error("Refund reconciliation fetch failed:", {
                refundId: String(refund._id),
                error: fetchError
            });

            res.status(502).json({
                message: "Could not confirm the refund with Razorpay yet.",
                refund: serializeRefund(refund)
            });
            return;
        }

        if (!razorpayRefund) {
            // No refund exists at Razorpay. Only safe to release when we
            // never stored an id (meaning the create call never succeeded).
            if (!refund.razorpayRefundId) {
                await releaseRefundReservation(
                    String(refund._id),
                    "No matching refund was found at Razorpay."
                );

                const updated = await Refund.findById(refund._id);

                res.status(200).json({
                    message:
                        "No refund found at Razorpay; the reservation was released.",
                    refund: updated ? serializeRefund(updated) : undefined
                });
                return;
            }

            res.status(409).json({
                message: "Razorpay has no record of this refund yet.",
                refund: serializeRefund(refund)
            });
            return;
        }

        const mappedStatus = mapRazorpayRefundStatus(razorpayRefund.status);

        if (mappedStatus === "PROCESSED") {
            const finalStatus = await finalizeRefund(String(refund._id));
            await respondWithRefundResult(res, String(refund._id), finalStatus);
            return;
        }

        if (mappedStatus === "FAILED") {
            await releaseRefundReservation(
                String(refund._id),
                "Razorpay reported the refund as failed during reconciliation."
            );

            const updated = await Refund.findById(refund._id);

            res.status(200).json({
                message: "Refund failed at Razorpay.",
                refund: updated ? serializeRefund(updated) : undefined
            });
            return;
        }

        // Still pending at Razorpay. Clear the reconciliation flag and keep
        // the reservation.
        await Refund.updateOne(
            { _id: refund._id, status: { $ne: "PROCESSED" } },
            { $set: { status: "PENDING", requiresReconciliation: false } }
        );

        const updated = await Refund.findById(refund._id);

        res.status(200).json({
            message: "Refund is still pending at Razorpay.",
            refund: updated ? serializeRefund(updated) : undefined
        });

    } catch (error) {

        console.error("Reconcile refund error:", error);

        res.status(500).json({
            message: "Failed to reconcile the refund."
        });
    }
};
