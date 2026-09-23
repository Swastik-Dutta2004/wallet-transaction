import { Request, Response } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";

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
    req: Request,
    res: Response
): Promise<void> => {

    try {

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body

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

        res.status(200).json({
            message: "Payment verified successfully.",
            payment: {
                razorpayOrderId: razorpay_order_id,
                razorpayPaymentId: razorpay_payment_id
            }
        })

    } catch (error) {

        console.error("Payment verification error:", error);

        res.status(500).json({
            message: "Internal server error."
        })

    }
}

