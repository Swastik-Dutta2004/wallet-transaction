import mongoose, { Document, Schema, Types } from "mongoose";

export interface IPaymentOrder extends Document {
    userId: Types.ObjectId;

    razorpayOrderId: string;

    amount: number;

    currency: string;

    idempotencyKey: string;

    status: "CREATED" | "PAID" | "FAILED";

    createdAt: Date;
    updatedAt: Date;
}

const paymentOrderSchema = new Schema<IPaymentOrder>(
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

        idempotencyKey: {
            type: String,
            required: true,
            unique: true
        },

        status: {
            type: String,
            enum: ["CREATED", "PAID", "FAILED"],
            default: "CREATED"
        }
    },
    {
        timestamps: true
    }
);

const PaymentOrder = mongoose.model<IPaymentOrder>(
    "PaymentOrder",
    paymentOrderSchema
);

export default PaymentOrder;