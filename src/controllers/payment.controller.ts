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
                message: "Amount must be at least 0.01."
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

        session.startTransaction();

        // Find user's wallet

        const wallet = await Wallet.findOne({
            ownerId: userId
        }).session(session);

        if (!wallet) {
            await session.abortTransaction();

            res.status(404).json({
                message: "Wallet not found."
            });
            return;
        }

        if (wallet.status !== "active") {
            await session.abortTransaction();

            res.status(400).json({
                message: "Wallet is not active."
            });
            return;
        }

        // 10. Update wallet balance

        const balanceBefore = wallet.balance;

        wallet.balance += paymentOrder.amount;

        const balanceAfter = wallet.balance;

        await wallet.save({ session });

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

        await payment.save({ session });

        // 12. Create wallet transaction

        const transaction = new Transaction({
            walletId: wallet._id,
            type: "CREDIT",
            amount: paymentOrder.amount,
            currency: paymentOrder.currency,
            status: "Success",

            // Reuse the PaymentOrder idempotency key so this write is
            // deduped against the webhook credit path for the same order
            idempotencyKey: paymentOrder.idempotencyKey,

            description: "Money added through Razorpay"
        });

        await transaction.save({ session });

        // 13. Create ledger entry

        const ledger = new Ledger({
            walletId: wallet._id,
            transactionId: transaction._id,
            type: "CREDIT",
            amount: paymentOrder.amount,
            balanceBefore,
            balanceAfter,
            currency: paymentOrder.currency,
            description: "Razorpay wallet recharge"
        });

        await ledger.save({ session });

        // 14. Update PaymentOrder

        paymentOrder.status = "PAID";

        await paymentOrder.save({ session });

        // 15. Commit everything

        await session.commitTransaction();

        res.status(200).json({
            message: "Payment verified and wallet credited successfully.",
            payment: {
                paymentId: payment.razorpayPaymentId,
                orderId: payment.razorpayOrderId,
                amount: payment.amount,
                currency: payment.currency
            },
            wallet: {
                balance: wallet.balance,
                currency: wallet.currency
            }
        });

    } catch (error) {

        if (session?.inTransaction()) {
            await session.abortTransaction();
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

            session.startTransaction();

            // 10. Re-check inside transaction
            // Protects against simultaneous webhook requests

            const existingTransaction =
                await Transaction.findOne({ idempotencyKey: paymentOrder.idempotencyKey }).session(session);

            if (existingTransaction) {

                await session.commitTransaction();

                res.status(200).json({
                    message: "Payment already processed."
                });

                return;
            }

            // 11. Find user's wallet

            const wallet = await Wallet.findOne({ ownerId: paymentOrder.userId }).session(session);

            if (!wallet) {

                await session.abortTransaction();

                res.status(404).json({
                    message: "Wallet not found."
                });

                return;
            }

            // 12. Check wallet status

            if (wallet.status !== "active") {

                await session.abortTransaction();

                res.status(400).json({
                    message: "Wallet is not active."
                });

                return;
            }

            // 13. Store balance before

            const balanceBefore = wallet.balance;

            // 14. Credit wallet

            wallet.balance += paymentOrder.amount;

            const balanceAfter = wallet.balance;

            await wallet.save({ session });

            // 15. Create Payment

            const payment = new Payment({
                userId: paymentOrder.userId,
                razorpayOrderId,
                razorpayPaymentId,
                razorpaySignature,
                amount: paymentOrder.amount,
                currency: paymentOrder.currency,
                status: "SUCCESS"
            });

            await payment.save({ session });

            // 16. Create Transaction

            const transaction = new Transaction({
                walletId: wallet._id,
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
                session
            });

            // 17. Create Ledger

            const ledger = new Ledger({
                walletId: wallet._id,
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
                session
            });

            // 18. Mark PaymentOrder as PAID

            paymentOrder.status = "PAID";

            await paymentOrder.save({
                session
            });

            // 19. Commit everything

            await session.commitTransaction();

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

            const paymentOrder =
                await PaymentOrder.findOne({
                    razorpayOrderId
                });

            if (paymentOrder) {

                paymentOrder.status = "FAILED";

                await paymentOrder.save();
            }

            res.status(200).json({
                message: "Payment failure webhook processed."
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


// Razorpay status values are lowercase and use their own words,
// for example "pending" or "processed".
// Our Refund model uses uppercase, so they are mapped explicitly
// instead of being stored as an unknown value.
const mapRazorpayRefundStatus = (
    razorpayStatus: string
): "PROCESSED" | "FAILED" => {

    return razorpayStatus === "processed" ? "PROCESSED" : "FAILED";
};
    

// Writes a FAILED Refund row OUTSIDE any MongoDB transaction.
//
// This exists for one specific situation: Razorpay already created the
// refund, but our database work afterwards failed.
//
// A MongoDB rollback can never undo a refund that Razorpay has already
// processed, so pretending the request simply failed would leave the
// wallet credited while the customer has already been made whole.
// Instead we keep a durable FAILED row containing the razorpayRefundId,
// which is the reconciliation trail for a human to follow up on.
//
// The row is written WITHOUT a session on purpose, because the
// transaction that failed must not be reused.
//
// A FAILED row does not count towards the refundable total, but it does
// occupy the idempotencyKey (unique index). That is deliberate: a client
// retrying the same key gets the FAILED refund back rather than silently
// triggering a SECOND real refund at Razorpay.
const recordFailedRefund = async (details: {
    userId: string;
    paymentId: string;
    razorpayPaymentId: string;
    razorpayRefundId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    reason?: string;
    failureReason: string;
}): Promise<void> => {

    try {
        await Refund.create({
            userId: details.userId,
            paymentId: details.paymentId,
            razorpayPaymentId: details.razorpayPaymentId,
            razorpayRefundId: details.razorpayRefundId,
            amount: details.amount,
            currency: details.currency,
            status: "FAILED",
            idempotencyKey: details.idempotencyKey,
            reason: details.reason,
            failureReason: details.failureReason
        });
    } catch (recordError) {
        // The reconciliation row itself failed. Swallow it so the
        // original error is not masked, but log loudly, because the only
        // remaining trace of this refund is now the log line below.
        console.error(
            "CRITICAL: could not record FAILED refund row. " +
            "This refund is only traceable via logs.",
            {
                idempotencyKey: details.idempotencyKey,
                razorpayRefundId: details.razorpayRefundId,
                razorpayPaymentId: details.razorpayPaymentId,
                error: recordError
            }
        );
    }
};


export const createRefund = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    const { paymentId, amount, reason } = req.body;

    const rawIdempotencyKey = req.headers["idempotency-key"];

    // 1. Check authenticated user

    const userId = req.user?.userId;

    if (!userId) {
        res.status(401).json({
            message: "User is not authenticated."
        });
        return;
    }

    // 2. Validate the Idempotency-Key header.
    // Done before the try block so it stays a plain string in the catch
    // block below, where TypeScript narrowing does not carry over.

    if (!rawIdempotencyKey || typeof rawIdempotencyKey !== "string") {
        res.status(400).json({
            message: "Idempotency-Key header is required."
        });
        return;
    }

    const idempotencyKey = rawIdempotencyKey;

    // Values captured now so the FAILED Refund row can be written later,
    // even if the transaction below rolls back
    let razorpayRefundId: string | undefined;

    let refundAmountInPaise = 0;

    let session: mongoose.ClientSession | undefined;

    try {

        // 3. Validate paymentId

        if (!paymentId || !mongoose.isValidObjectId(paymentId)) {
            res.status(400).json({
                message: "A valid paymentId is required."
            });
            return;
        }

        // 4. Validate amount.
        // The frontend sends RUPEES, we store and send PAISA.

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

        refundAmountInPaise = Math.round(amount * 100);

        if (refundAmountInPaise < 1) {
            res.status(400).json({
                message: "Amount must be at least 0.01."
            });
            return;
        }

        // 5. Idempotency replay.
        // Checked before anything else so a retried request never reaches
        // Razorpay a second time.

        const existingRefund = await Refund.findOne({
            idempotencyKey
        });

        if (existingRefund) {
            res.status(200).json({
                message: "Request already processed.",
                refund: {
                    id: existingRefund._id,
                    razorpayRefundId: existingRefund.razorpayRefundId,
                    paymentId: existingRefund.paymentId,
                    amount: existingRefund.amount,
                    currency: existingRefund.currency,
                    status: existingRefund.status
                }
            });
            return;
        }

        // 6. Find the Payment. The stored Payment is the source of truth
        // for the original amount, we never trust the frontend for it.

        const payment = await Payment.findOne({
            _id: paymentId
        });

        if (!payment) {
            res.status(404).json({
                message: "Payment not found."
            });
            return;
        }

        // 7. The Payment must belong to the authenticated user

        if (payment.userId.toString() !== userId) {
            res.status(403).json({
                message: "This payment does not belong to you."
            });
            return;
        }

        // 8. Only a successful payment can be refunded.
        // status stays "SUCCESS" even after a partial refund, so this
        // check does not block later partial refunds.

        if (payment.status !== "SUCCESS") {
            res.status(400).json({
                message: "Only a successful payment can be refunded."
            });
            return;
        }

        // 9. Friendly pre-check on the refundable amount.
        // NOT authoritative, see step 12 for the real guard.

        const alreadyRefunded = payment.refundedAmount ?? 0;

        const refundableAmount = payment.amount - alreadyRefunded;

        if (refundAmountInPaise > refundableAmount) {
            res.status(409).json({
                message:
                    "Refund exceeds the remaining refundable amount.",
                paymentAmount: payment.amount,
                alreadyRefunded,
                refundableAmount
            });
            return;
        }

        // =====================================================
        // 10. CALL RAZORPAY
        //
        // This is an EXTERNAL network call, so it is deliberately made
        // BEFORE the MongoDB transaction opens and is never placed
        // inside one. Holding a transaction open across a network
        // round trip is what causes long running transactions and
        // snapshot write conflicts.
        //
        // If this throws, nothing has been written to MongoDB yet and
        // there is nothing to undo.
        // =====================================================

        let razorpayRefund;

        try {
            razorpayRefund = await razorpay.payments.refund(
                payment.razorpayPaymentId,
                {
                    amount: refundAmountInPaise
                }
            );
        } catch (razorpayError) {
            // Log the detail, never send it to the client, so the
            // Razorpay secret and internal messages stay server side
            console.error(
                "Razorpay refund API call failed:",
                razorpayError
            );

            res.status(500).json({
                message: "Failed to process the refund with Razorpay."
            });
            return;
        }

        razorpayRefundId = razorpayRefund.id;

        // Razorpay accepted the refund, so from here on any failure is
        // the reconciliation case described in recordFailedRefund
        console.log(
            "Razorpay refund created:",
            {
                razorpayRefundId,
                razorpayPaymentId: payment.razorpayPaymentId,
                amount: refundAmountInPaise,
                status: razorpayRefund.status
            }
        );

        // =====================================================
        // START MONGODB TRANSACTION
        // =====================================================

        session = await mongoose.startSession();

        session.startTransaction();

        // 11. ATOMIC CAP CLAIM. This is the authoritative guard against
        // two concurrent refunds over-refunding the same payment.
        //
        // The filter and the $inc are applied as ONE atomic operation.
        // The $expr condition re-checks the cap against the value the
        // $inc is about to produce, so a request that would push the
        // total past payment.amount matches nothing and returns null.
        //
        // If the claim fails we abort WITHOUT touching the wallet, so a
        // losing racer can never debit the customer for a refund that
        // was not allowed.

        const claimedPayment = await Payment.findOneAndUpdate(
            {
                _id: payment._id,
                userId: payment.userId,
                status: "SUCCESS",
                $expr: {
                    $lte: [
                        {
                            $add: [
                                // $ifNull guards payments stored before
                                // refundedAmount existed. A missing field
                                // evaluates to null inside an aggregation
                                // expression, not 0, so it is coerced
                                // explicitly here.
                                { $ifNull: ["$refundedAmount", 0] },
                                refundAmountInPaise
                            ]
                        },
                        "$amount"
                    ]
                }
            },
            {
                $inc: { refundedAmount: refundAmountInPaise }
            },
            { new: true, session }
        );

        if (!claimedPayment) {

            await session.abortTransaction();

            console.error(
                "CRITICAL: refund cap was exceeded during the " +
                "transaction. Razorpay already refunded this amount but " +
                "the wallet was NOT debited. Manual reconciliation needed.",
                {
                    razorpayRefundId,
                    razorpayPaymentId: payment.razorpayPaymentId,
                    paymentId: payment._id.toString(),
                    requestedAmount: refundAmountInPaise,
                    idempotencyKey
                }
            );

            await recordFailedRefund({
                userId,
                paymentId: payment._id.toString(),
                razorpayPaymentId: payment.razorpayPaymentId,
                razorpayRefundId,
                amount: refundAmountInPaise,
                currency: payment.currency,
                idempotencyKey,
                reason,
                failureReason:
                    "Refund cap exceeded at commit time (concurrent request)"
            });

            res.status(409).json({
                message:
                    "Refund exceeds the remaining refundable amount."
            });
            return;
        }

        // 12. Find the user's wallet

        const wallet = await Wallet.findOne({
            ownerId: userId
        }).session(session);

        if (!wallet) {

            await session.abortTransaction();

            await recordFailedRefund({
                userId,
                paymentId: payment._id.toString(),
                razorpayPaymentId: payment.razorpayPaymentId,
                razorpayRefundId,
                amount: refundAmountInPaise,
                currency: payment.currency,
                idempotencyKey,
                reason,
                failureReason: "Wallet not found"
            });

            res.status(404).json({
                message: "Wallet not found."
            });
            return;
        }

        // 13. Check the wallet can absorb the debit

        if (wallet.status !== "active") {

            await session.abortTransaction();

            await recordFailedRefund({
                userId,
                paymentId: payment._id.toString(),
                razorpayPaymentId: payment.razorpayPaymentId,
                razorpayRefundId,
                amount: refundAmountInPaise,
                currency: payment.currency,
                idempotencyKey,
                reason,
                failureReason: "Wallet is not active"
            });

            res.status(400).json({
                message: "Wallet is not active."
            });
            return;
        }

        if (wallet.balance < refundAmountInPaise) {

            await session.abortTransaction();

            await recordFailedRefund({
                userId,
                paymentId: payment._id.toString(),
                razorpayPaymentId: payment.razorpayPaymentId,
                razorpayRefundId,
                amount: refundAmountInPaise,
                currency: payment.currency,
                idempotencyKey,
                reason,
                failureReason: "Insufficient wallet balance"
            });

            res.status(400).json({
                message: "Insufficient wallet balance."
            });
            return;
        }

        // 14. Debit the wallet

        const balanceBefore = wallet.balance;

        wallet.balance -= refundAmountInPaise;

        const balanceAfter = wallet.balance;

        await wallet.save({ session });

        // 15. Create the Refund record

        const refund = new Refund({
            userId,
            paymentId: payment._id,
            razorpayPaymentId: payment.razorpayPaymentId,
            razorpayRefundId,
            amount: refundAmountInPaise,
            currency: payment.currency,
            status: mapRazorpayRefundStatus(razorpayRefund.status),
            idempotencyKey,
            reason
        });

        await refund.save({ session });

        // 16. Create the DEBIT Transaction

        const transaction = new Transaction({
            walletId: wallet._id,
            type: "DEBIT",
            amount: refundAmountInPaise,
            currency: payment.currency,
            status: "Success",
            idempotencyKey,
            description: "Refund for Razorpay payment"
        });

        await transaction.save({ session });

        // 17. Create the DEBIT Ledger

        const ledger = new Ledger({
            walletId: wallet._id,
            transactionId: transaction._id,
            type: "DEBIT",
            amount: refundAmountInPaise,
            balanceBefore,
            balanceAfter,
            currency: payment.currency,
            description: "Razorpay payment refund"
        });

        await ledger.save({ session });

        // 18. Commit everything

        await session.commitTransaction();

        res.status(200).json({
            message: "Refund processed successfully.",
            refund: {
                id: refund._id,
                razorpayRefundId: refund.razorpayRefundId,
                paymentId: refund.paymentId,
                razorpayPaymentId: refund.razorpayPaymentId,
                amount: refund.amount,
                currency: refund.currency,
                status: refund.status
            },
            wallet: {
                id: wallet._id,
                balance: wallet.balance,
                currency: wallet.currency
            },
            payment: {
                amount: payment.amount,
                refundedAmount: claimedPayment.refundedAmount,
                refundableAmount:
                    claimedPayment.amount - claimedPayment.refundedAmount
            }
        });

    } catch (error) {

        // Only failures that happen AFTER Razorpay succeeded need a
        // FAILED reconciliation row. If we never reached Razorpay, there
        // is nothing external to reconcile.
        if (razorpayRefundId) {

            if (session?.inTransaction()) {
                await session.abortTransaction();
            }

            console.error(
                "CRITICAL: Razorpay refund succeeded but the MongoDB " +
                "transaction failed. The wallet was NOT debited and the " +
                "customer HAS been refunded at Razorpay. Manual " +
                "reconciliation is required.",
                {
                    razorpayRefundId,
                    paymentId,
                    idempotencyKey,
                    amount: refundAmountInPaise,
                    error
                }
            );

            const payment = await Payment.findById(paymentId).lean();

            await recordFailedRefund({
                userId: String(req.user?.userId),
                paymentId: String(paymentId),
                razorpayPaymentId: payment?.razorpayPaymentId ?? "",
                razorpayRefundId,
                amount: refundAmountInPaise,
                currency: payment?.currency ?? "INR",
                idempotencyKey,
                reason,
                failureReason: "MongoDB transaction failed after refund"
            });
        }

        console.error("Create refund error:", error);

        res.status(500).json({
            message: "Failed to process the refund."
        });

    } finally {

        await session?.endSession();
    }
};

