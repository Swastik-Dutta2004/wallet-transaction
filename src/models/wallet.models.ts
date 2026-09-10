import mongoose, {Document, Schema, Types} from "mongoose"

export interface IWallet extends Document{
    ownerId: Types.ObjectId,
    balance: number,
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
})

const Wallet = mongoose.model("Wallet", walletSchema)

export default Wallet