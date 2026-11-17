import mongoose, {Document, Schema, Types} from "mongoose"

export interface IWallet extends Document{
    ownerId: Types.ObjectId,
    balance: number,

    // Funds held for refunds that are still in flight. These rupees are
    // still in `balance` but may not be spent, so the refund can always be
    // honoured when Razorpay confirms it. Available balance is
    // `balance - reservedBalance`.
    reservedBalance: number,

    currency: string,
    status: "active" | "frozen"
    createdAt: Date,
    updatedAt: Date,
}


const walletSchema = new Schema<IWallet>({
    ownerId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true
    },

    balance: {
        type: Number,
        required: true,
        default: 0,
        min: 0,

        // Reserved funds are still part of `balance` but may not be spent,
        // so the reserved amount can never exceed the total. Enforced on
        // `balance` because it is always present, unlike reservedBalance on
        // legacy documents.
        validate: {
            validator: function (value: number): boolean {
                const wallet = this as unknown as { reservedBalance?: number }

                return (wallet.reservedBalance ?? 0) <= value
            },
            message: "reservedBalance cannot exceed balance"
        }
    },

    reservedBalance: {
        type: Number,
        required: true,
        default: 0,
        min: 0
    },

    currency: {
        type : String,
        required: true,
        default: "INR"
    },

    status: {
        type: String,
        enum: ["active", "frozen"],
        default: "active"
    }
}, {
    timestamps: true
})

const walletModel = mongoose.model("Wallet", walletSchema)

export default walletModel