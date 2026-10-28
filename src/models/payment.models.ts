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