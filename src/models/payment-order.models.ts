//This is for create-order

import mongoose, { Document, Schema, Types } from "mongoose";

export interface IPaymentOrder extends Document {
    userId: Types.ObjectId;

    razorpayOrderId: string;

    amount: number;

    currency: string;

    idempotencyKey: string;

    status: "CREATED" | "PAID" | "FAILED";

    // null on a new creation claim, set only immediately before the first
    // Razorpay call. Absent means a pre-recovery-version record.
    creationDispatchedAt?: Date | null;

    // Unique token for the current creation attempt. Recovery clears it so a
    // stale request cannot advance an already-reclaimed order.
    creationClaimToken?: string | null;

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
        },

        creationDispatchedAt: {
            type: Date,
            default: null
        },

        creationClaimToken: {
            type: String,
            default: null
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