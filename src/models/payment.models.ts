import mongoose, { Document, Schema, Types } from "mongoose";

export interface IPayment extends Document {
    userId: Types.ObjectId;

    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;

    amount: number;
    currency: string;

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