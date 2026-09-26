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
        if (!amount || amount <= 0) {
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

        // Check if this request was already processed
        const existingPaymentOrder = await PaymentOrder.findOne({
            idempotencyKey
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

        // Convert INR to paise
        const amountInPaise = Math.round(amount * 100);

        // Create order on Razorpay
        const order = await razorpay.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: `receipt_${Date.now()}`
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

    const session = await mongoose.startSession();

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

        if (expectedSignature !== razorpay_signature) {
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

        await session.abortTransaction();

        console.error("Payment verification error:", error);

        res.status(500).json({
            message: "Payment verification failed."
        });

    } finally {
        session.endSession();
    }
};



export const handleWebhook = async (
    req: Request,
    res: Response
): Promise<void> => {

    const session = await mongoose.startSession();

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

        if (
            !razorpaySignature ||
            typeof razorpaySignature !== "string"
        ) {
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

        if (expectedSignature !== razorpaySignature) {
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

            const razorpayPaymentId =
                paymentEntity.id;

            const razorpayOrderId =
                paymentEntity.order_id;

            const amount =
                paymentEntity.amount;

            const currency =
                paymentEntity.currency;

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

            session.startTransaction();

            // 10. Re-check inside transaction
            // Protects against simultaneous webhook requests

            const existingTransaction =
                await Transaction.findOne({
                    idempotencyKey:
                        paymentOrder.idempotencyKey
                }).session(session);

            if (existingTransaction) {

                await session.commitTransaction();

                res.status(200).json({
                    message: "Payment already processed."
                });

                return;
            }

            // 11. Find user's wallet

            const wallet =
                await Wallet.findOne({
                    ownerId: paymentOrder.userId
                }).session(session);

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

            const balanceBefore =
                wallet.balance;

            // 14. Credit wallet

            wallet.balance += paymentOrder.amount;

            const balanceAfter =
                wallet.balance;

            await wallet.save({
                session
            });

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

            await payment.save({
                session
            });

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

                idempotencyKey:
                    paymentOrder.idempotencyKey,

                description:
                    "Money added through Razorpay webhook"
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

        if (session.inTransaction()) {
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

        await session.endSession();
    }
};

