const mongoose = require("mongoose")

const walletSchema = new mongoose.Schema({
    ownerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        require: true,
        unique: true
    },

    balance: {
        type: Number,
        require: true,
        default: 0,
        min: 0
    },

    currecncy: {
        type : String,
        require: true,
        default: "INR"
    },

    status: {
        type: String,
        enum: ["active", "frozen"],
        default: "active"
    }
})

const WalletModel = mongoose.model("Wallet", walletSchema)

module.exports = WalletModel