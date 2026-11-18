import mongoose, {Document, Types, Schema} from "mongoose"

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
            min: 1,

            // Money is stored as integer paise.
            validate: {
                validator: (value: number): boolean => Number.isInteger(value),
                message: "amount must be a positive integer number of paise"
            }
        },

        balanceBefore: {
            type: Number,
            required: true,
            min: 0,

            validate: {
                validator: (value: number): boolean => Number.isInteger(value),
                message: "balanceBefore must be an integer number of paise"
            }
        },

        balanceAfter: {
            type: Number,
            required: true,
            min: 0,

            // A ledger row must be arithmetically consistent with the entry
            // it records. Checked on balanceAfter because it is always
            // present and its expected value depends on the sibling fields.
            validate: {
                validator: function (value: number): boolean {
                    const entry = this as unknown as {
                        type?: string;
                        amount?: number;
                        balanceBefore?: number;
                    };

                    if (entry.type !== "CREDIT" && entry.type !== "DEBIT") {
                        return true;
                    }

                    if (
                        !Number.isInteger(entry.amount) ||
                        !Number.isInteger(entry.balanceBefore)
                    ) {
                        return false;
                    }

                    const expected =
                        entry.type === "CREDIT"
                            ? (entry.balanceBefore as number) + (entry.amount as number)
                            : (entry.balanceBefore as number) - (entry.amount as number);

                    return value === expected;
                },
                message:
                    "balanceAfter must equal balanceBefore plus amount (CREDIT) or minus amount (DEBIT)"
            }
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

// A single transaction may only write one entry of a given type for a given
// wallet. This blocks accidental double posting (for example a retried refund
// writing the debit twice) at the database level. Keeping `type` also leaves
// the two transfer rows distinct because their walletId differs. Tightening
// this to (transactionId, walletId) requires a duplicate check on existing
// data first, so it is deliberately not changed here.
ledgerSchema.index(
    { transactionId: 1, walletId: 1, type: 1 },
    { unique: true }
);

// Ledger rows are append-only. Mongoose 9 pre hooks have no `next()`; throwing
// aborts the operation before any database write is sent.
ledgerSchema.pre("save", async function () {
    if (!this.isNew && this.isModified()) {
        throw new Error("Ledger entries are immutable.")
    }
})

ledgerSchema.pre(
    [
        "updateOne",
        "updateMany",
        "replaceOne",
        "findOneAndUpdate",
        "deleteOne",
        "deleteMany",
        "findOneAndDelete"
    ],
    async function () {
        throw new Error("Ledger entries are immutable.")
    }
)

const ledgerModel = mongoose.model("Ledger", ledgerSchema)

export default ledgerModel