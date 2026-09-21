import mongoose, {Document, Types, Schema, mongo} from "mongoose"

export interface ILedger extends Document{
    walletId: Types.ObjectId;
    transactionId: Types.ObjectId;

    type: "CREDIT" | "DEBIT";

    amount: number;
    balanceBefore: number;
    balanceAfter: number

    currency: string;

    description?: string;

    createdAt: Date
}

const ledgerSchema = new Schema<ILedger>(
    {
        walletId: {
            type: Schema.Types.ObjectId,
            ref: "Wallet",
            required: true
        },

        transactionId: {
            type: Schema.Types.ObjectId,
            ref: "Transaction",
            required: true
        },

        type: {
            type: String,
            enum: ["CREDIT", "DEBIT"],
            required: true
        },

        amount: {
            type: Number,
            required: true,
            min: 1
        },

        balanceBefore: {
            type: Number,
            required: true,
            min: 0
        },

        balanceAfter: {
            type: Number,
            required: true,
            min: 0
        },

        currency: {
            type: String,
            required: true,
            default: "INR"
        },

        description: {
            type: String,
            trim: true
        },

        createdAt: {
            type: Date,
            default: Date.now
        }
    }
);

const ledgerModel = mongoose.model("Ledger", ledgerSchema)

export default ledgerModel