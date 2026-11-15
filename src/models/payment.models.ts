import mongoose, { Document, Schema, Types } from "mongoose";

export interface IPayment extends Document {
    userId: Types.ObjectId;

    razorpayOrderId: string;
    razorpayPaymentId: string;

    // The Razorpay Checkout signature (HMAC of "order_id|payment_id").
    // Only payments verified through the Checkout flow have this. A payment
    // created from a webhook has no Checkout signature, so this is optional.
    // It must NEVER hold a webhook signature: those are a different value
    // (an HMAC of the raw webhook body) and are verified separately.
    razorpaySignature?: string;

    amount: number;
    currency: string;

    // Running total of refunds already applied to this payment, in paise.
    // Partial refunds are supported, so `status` deliberately stays
    // "SUCCESS" and is never flipped to "REFUNDED". This field is the
    // source of truth for "how much is still refundable" and is the field
    // the atomic over-refund guard increments, so the cap cannot be
    // raced past by two concurrent refund requests.
    refundedAmount: number;

    // Capacity currently reserved by refunds that are still in flight.
    // A pending refund holds its amount here but is NOT counted in
    // refundedAmount, so an unconfirmed refund is never reported as a
    // completed one. Invariant: refundedAmount + reservedRefundAmount
    // must never exceed amount.
    reservedRefundAmount: number;

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
            type: String
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
            min: 0,

            // Document-level guard: the total refunded amount must never
            // exceed the original payment amount.
            //
            // IMPORTANT: this only runs during document validation
            // (save() / validate()). Mongoose does NOT run document
            // validators for update operators such as
            // findOneAndUpdate({ $inc: { refundedAmount } }), so this does
            // NOT protect the refund path. The authoritative protection
            // there is the atomic $expr + $inc condition in createRefund,
            // which must stay in place.
            validate: {
                validator: function (value: number): boolean {
                    // During document validation `this` is the document.
                    // During update validation `this` is a Query and has no
                    // usable `amount`, so nothing can be checked here.
                    const document = this as unknown as { amount?: number };

                    return typeof document.amount !== "number"
                        || value <= document.amount;
                },
                message: "refundedAmount cannot be greater than amount"
            }
        },

        // Reserved refund capacity. Like refundedAmount, this is moved by
        // atomic $inc operations, so the schema-level rules below are only a
        // secondary guard. The authoritative cap check is the $expr guard in
        // the refund controller.
        reservedRefundAmount: {
            type: Number,
            required: true,
            default: 0,
            min: 0,

            validate: {
                validator: function (value: number): boolean {
                    const document = this as unknown as { amount?: number };

                    return typeof document.amount !== "number"
                        || value <= document.amount;
                },
                message: "reservedRefundAmount cannot be greater than amount"
            }
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