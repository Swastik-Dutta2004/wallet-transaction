import mongoose, { Document, Schema, Types } from "mongoose";

// Lifecycle of a refund:
//
//   CREATED   - the idempotency key has been claimed and the refund capacity
//               and wallet funds have been reserved. Razorpay has not
//               confirmed anything yet (the call is in flight, or the
//               process stopped before the call). `dispatchClaimed` records
//               whether permission to call Razorpay was atomically taken.
//   PENDING   - Razorpay accepted the refund (or the outcome is unknown,
//               e.g. a timeout) but it is NOT completed yet. The
//               reservation stays held and the wallet is NOT debited.
//   PROCESSED - Razorpay processed the refund AND our wallet was debited.
//               This is the only state that counts as a completed refund.
//   FAILED    - the refund will definitely not happen. The reservation has
//               been released and the wallet was NOT debited.
//
// A PENDING or CREATED refund is never counted in Payment.refundedAmount.
export type RefundStatus = "CREATED" | "PENDING" | "PROCESSED" | "FAILED";

export interface IRefund extends Document {
    userId: Types.ObjectId;

    paymentId: Types.ObjectId;

    razorpayPaymentId: string;

    // Only set once Razorpay has actually created the refund.
    // sparse so that rows without one do not collide on null.
    razorpayRefundId?: string;

    // Stored in paise, same as Wallet.balance and Payment.amount.
    amount: number;

    currency: string;

    status: RefundStatus;

    // True while this refund is holding capacity on Payment.reservedRefundAmount
    // and funds on Wallet.reservedBalance. It is set to false once the refund
    // is finalized (debited) or its reservation is released.
    reservationActive: boolean;

    // Atomically set immediately before calling Razorpay. Reconciliation must
    // not release the reservation while this is true: the external refund may
    // be in flight, or may already have succeeded without its id being stored
    // locally. Default false keeps legacy rows readable; queries that need to
    // prove dispatch never happened use an explicit `false` match, so legacy
    // rows without the field fail closed.
    dispatchClaimed: boolean;

    // True when we could not confirm the final state, for example a timeout
    // while calling Razorpay, or a database failure after Razorpay already
    // refunded the customer. Such a row must be reconciled manually.
    requiresReconciliation: boolean;

    idempotencyKey: string;

    reason?: string;

    // Explains a FAILED status or a PENDING row that needs reconciliation.
    // Kept separate from `reason` so the customer facing reason is never
    // overwritten by an internal note.
    failureReason?: string;

    finalizedAt?: Date;

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
            enum: ["CREATED", "PENDING", "PROCESSED", "FAILED"],
            default: "CREATED",
            index: true
        },

        reservationActive: {
            type: Boolean,
            required: true,
            default: false
        },

        dispatchClaimed: {
            type: Boolean,
            required: true,
            default: false
        },

        requiresReconciliation: {
            type: Boolean,
            required: true,
            default: false
        },

        // Unique at the database level, so two concurrent requests carrying
        // the same key cannot both reach Razorpay. The loser gets E11000 and
        // is answered with the existing refund instead of creating a second
        // real refund at Razorpay.
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
        },

        finalizedAt: {
            type: Date
        }
    },
    {
        timestamps: true
    }
);

const Refund = mongoose.model<IRefund>("Refund", refundSchema);

export default Refund;
