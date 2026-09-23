import { Request, Response } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";

import mongoose from "mongoose";

import Payment from "../models/payment.models";
import Wallet from "../models/wallet.models";
import Transaction from "../models/transaction.models";
import Ledger from "../models/ledger.models";
import { AuthRequest } from "../middleware/auth.middleware"

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!
});

export const createOrder = async (
    req: Request,
    res: Response
): Promise<void> => {
    try {
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            res.status(400).json({
                message: "Amount must be greater than 0."
            });
            return;
        }

        // Convert INR to paise
        const amountInPaise = Math.round(amount * 100);

        const order = await razorpay.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: `receipt_${Date.now()}`
        });

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
        session.startTransaction();

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body;

        const userId = req.user?.userId;

        if (
            !razorpay_order_id ||
            !razorpay_payment_id ||
            !razorpay_signature
        ) {
            await session.abortTransaction();

            res.status(400).json({
                message: "Payment verification details are required."
            });
            return;
        }

        if (!userId) {
            await session.abortTransaction();

            res.status(401).json({
                message: "User is not authenticated."
            });
            return;
        }

        const secret = process.env.RAZORPAY_KEY_SECRET;

        if (!secret) {
            await session.abortTransaction();

            res.status(500).json({
                message: "Razorpay secret is not configured."
            });
            return;
        }

        // 1. Verify Razorpay signature

        const body =
            razorpay_order_id + "|" + razorpay_payment_id;

        const expectedSignature = crypto
            .createHmac("sha256", secret)
            .update(body)
            .digest("hex");

        if (expectedSignature !== razorpay_signature) {
            await session.abortTransaction();

            res.status(400).json({
                message: "Payment verification failed."
            });
            return;
        }

        // 2. Check whether this payment was already processed

        const existingPayment = await Payment.findOne({
            razorpayPaymentId: razorpay_payment_id
        }).session(session);

        if (existingPayment) {
            await session.abortTransaction();

            res.status(200).json({
                message: "Payment has already been processed.",
                paymentId: existingPayment.razorpayPaymentId
            });
            return;
        }

        // 3. Find user's wallet

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

        // We will get the amount from the Razorpay order
        // in the next refinement.
        //
        // For now this is only the verification flow.

        res.status(200).json({
            message: "Payment verified successfully.",
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id
        });

    } catch (error) {
        await session.abortTransaction();

        console.error("Payment verification error:", error);

        res.status(500).json({
            message: "Internal server error."
        });
    } finally {
        session.endSession();
    }
};
