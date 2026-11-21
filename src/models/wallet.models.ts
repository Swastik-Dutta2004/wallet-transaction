import mongoose, {Document, Schema, Types} from "mongoose"

const isPaiseAmount = (value: number): boolean =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0

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

        validate: {
            validator: (value: number): boolean => isPaiseAmount(value),
            message: "balance must be a finite non-negative integer number of paise"
        }
    },

    reservedBalance: {
        type: Number,
        required: true,
        default: 0,
        min: 0,

        validate: {
            validator: (value: number): boolean => isPaiseAmount(value),
            message:
                "reservedBalance must be a finite non-negative integer number of paise"
        }
    },

    currency: {
        type : String,
        required: true,
        default: "INR",
        enum: ["INR"],
        trim: true,
        uppercase: true
    },

    status: {
        type: String,
        enum: ["active", "frozen"],
        default: "active"
    }
}, {
    timestamps: true
})

walletSchema.path("balance").validate(
    function (this: IWallet, value: number): boolean {
        return (this.reservedBalance ?? 0) <= value
    },
    "reservedBalance cannot exceed balance"
)

walletSchema.path("reservedBalance").validate(
    function (this: IWallet, value: number): boolean {
        return value <= (this.balance ?? 0)
    },
    "reservedBalance cannot exceed balance"
)

const walletModel = mongoose.model("Wallet", walletSchema)

export default walletModel