import mongoose, { Document, Schema, Types } from "mongoose";

export interface IRefund extends Document {
    userId: Types.ObjectId;

    paymentId: Types.ObjectId;

    razorpayPaymentId: string;

    // Only set once Razorpay has actually created the refund.
    // sparse so that rows without one do not collide on null
    razorpayRefundId?: string;

    // Stored in paise, same as Wallet.balance and Payment.amount
    amount: number;

    currency: string;

    // CREATED   - reserved, Razorpay has not confirmed yet
    // PROCESSED - Razorpay refunded AND our wallet was debited
    // FAILED    - Razorpay refunded BUT our MongoDB transaction failed.
    //              The wallet was NOT debited and needs manual reconciliation.
    status: "CREATED" | "PROCESSED" | "FAILED";

    idempotencyKey: string;

    reason?: string;

    // Explains a FAILED status. Kept separate from `reason`
    // so the customer facing reason is never overwritten by an error
    failureReason?: string;

    createdAt: Date;
    updatedAt: Date;
}

const refundSchema = new Schema<IRefund>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        paymentId: {
            type: Schema.Types.ObjectId,
            ref: "Payment",
            required: true,
            index: true
        },

        razorpayPaymentId: {
            type: String,
            required: true,
            index: true
        },

        razorpayRefundId: {
            type: String,
            unique: true,
            sparse: true
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
            enum: ["CREATED", "PROCESSED", "FAILED"],
            default: "CREATED",
            index: true
        },

        // Unique at the database level, so two concurrent requests
        // carrying the same key cannot both create a refund.
        // The second insert fails with E11000 instead of silently
        // issuing a second real refund at Razorpay.
        idempotencyKey: {
            type: String,
            required: true,
            unique: true
        },

        reason: {
            type: String,
            trim: true
        },

        failureReason: {
            type: String,
            trim: true
        }
    },
    {
        timestamps: true
    }
);

const Refund = mongoose.model<IRefund>("Refund", refundSchema);

export default Refund;
