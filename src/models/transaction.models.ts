import mongoose, { Schema, Document, Types } from "mongoose"

export interface ITransaction extends Document {
    // Different transaction types use different wallet references:
    // CREDIT/DEBIT use `walletId`, TRANSFER uses the sender/receiver pair.
    // They stay optional at the field level because the required combination
    // depends on `type`, and is enforced by the `type` validator below.
    walletId?: Types.ObjectId,

    senderWalletId?: Types.ObjectId,
    receiverWalletId?: Types.ObjectId,

    type: "CREDIT" | "DEBIT" | "TRANSFER",

    amount: number,
    currency: string,

    status: "Success" | "Pending" | "Failed",

    idempotencyKey?: string;

    // SHA-256 of the canonical request parameters. When a client retries
    // with the same Idempotency-Key we can prove the parameters are
    // identical instead of blindly replaying (or silently double crediting).
    requestFingerprint?: string;

    description?: string,

    createdAt: Date,
    updatedAt: Date,
}

const transcationSchema = new Schema<ITransaction>(
    {
        walletId: {
            type: Schema.Types.ObjectId,
            ref: "Wallet",
            index: true
        },

        senderWalletId: {
            type: Schema.Types.ObjectId,
            ref: "Wallet",
            index: true
        },

        receiverWalletId: {
            type: Schema.Types.ObjectId,
            ref: "Wallet",
            index: true
        },

        type: {
            type: String,
            enum: ["CREDIT", "DEBIT", "TRANSFER"],
            required: true,

            // Cross-field validation lives on `type` because it is always
            // present. A validator on walletId/senderWalletId would be
            // skipped whenever that field is undefined.
            validate: {
                validator: function (value: string): boolean {
                    const transaction = this as unknown as {
                        walletId?: unknown;
                        senderWalletId?: unknown;
                        receiverWalletId?: unknown;
                    };

                    const hasWalletId = transaction.walletId != null;
                    const hasSender = transaction.senderWalletId != null;
                    const hasReceiver = transaction.receiverWalletId != null;

                    if (value === "CREDIT" || value === "DEBIT") {
                        return hasWalletId && !hasSender && !hasReceiver;
                    }

                    if (value === "TRANSFER") {
                        return (
                            !hasWalletId &&
                            hasSender &&
                            hasReceiver &&
                            String(transaction.senderWalletId) !==
                            String(transaction.receiverWalletId)
                        );
                    }

                    return false;
                },
                message:
                    "CREDIT/DEBIT require only walletId; TRANSFER requires distinct senderWalletId and receiverWalletId."
            }
        },

        amount: {
            type: Number,
            required: true,
            min: 1,

            // Money is stored as integer paise. Reject 1.5, NaN, Infinity,
            // and anything else that is not a whole positive number.
            validate: {
                validator: (value: number): boolean => Number.isInteger(value),
                message: "amount must be a positive integer number of paise"
            }
        },

        currency: {
            type: String,
            required: true,
            default: "INR"
        },

        status: {
            type: String,
            enum: ["Success", "Pending", "Failed"],
            default: "Pending"
        },

        idempotencyKey: {
            type: String,
            unique: true,
            sparse: true
        },

        // Internal only: never selected into API responses.
        requestFingerprint: {
            type: String
        },

        description: {
            type: String,
            trim: true
        }
    },
    {
        timestamps: true
    }
)

const transactionModel = mongoose.model<ITransaction>("Transaction", transcationSchema)

export default transactionModel
