import mongoose, { Document, Schema, Types } from "mongoose";

export interface IPayment extends Document {
    userId: Types.ObjectId;

    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;

    amount: number;
    currency: string;

    // Running total of refunds already applied to this payment, in paise.
    // Partial refunds are supported, so `status` deliberately stays
    // "SUCCESS" and is never flipped to "REFUNDED". This field is the
    // source of truth for "how much is still refundable" and is the field
    // the atomic over-refund guard increments, so the cap cannot be
    // raced past by two concurrent refund requests.
    refundedAmount: number;

    status: "SUCCESS" | "FAILED";

    createdAt: Date;
    updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        razorpayOrderId: {
            type: String,
            required: true,
            unique: true
        },

        razorpayPaymentId: {
            type: String,
            required: true,
            unique: true
        },

        razorpaySignature: {
            type: String,
            required: true
        },

        amount: {
            type: Number,
            required: true,
            min: 1
        },

        currency: {
            type: String,
            required: true,
            default: "INR"
        },

        refundedAmount: {
            type: Number,
            required: true,
            default: 0,
            min: 0
        },

        status: {
            type: String,
            enum: ["SUCCESS", "FAILED"],
            required: true
        }
    },
    {
        timestamps: true
    }
);

const Payment = mongoose.model<IPayment>(
    "Payment",
    paymentSchema
);

export default Payment;