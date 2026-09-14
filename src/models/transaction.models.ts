import mongoose, {Schema, Document, Types} from "mongoose"
import walletModel from "./wallet.models";

export interface ITransaction extends Document {
    walletID : Types.ObjectId,

    senderWalletId : Types.ObjectId,
    reciverWalletId: Types.ObjectId,

    type: "CREDIT" | "DEBIT" | "TRANSFER",

    amount: number,
    currency: string,

    status: "Success" | "Pending" | "Failed",

    description?: string,
    
    createdAt: Date,
    updatedAt: Date,
}

const transcationSchema = new Schema<ITransaction> (
    {
        walletID: {
            type: Schema.Types.ObjectId,
            ref: "Wallet",
            required: true 
        },

        senderWalletId: {
            type: Schema.Types.ObjectId,
            ref: "Wallet"
        },

        reciverWalletId: {
            type: Schema.Types.ObjectId,
            ref: "Wallet"
        },

        type:{
            type: String,
            enum: ["CREDIT", "DEBIT", "TRANSFER"],
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

        status: {
            type: String,
            enum: ["Success", "Pending", "Failed"],
            default: "Pending"
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