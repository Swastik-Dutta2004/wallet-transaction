import { Request, Response } from "express"
import walletModel from "../models/wallet.models"
import transactionModel from "../models/transaction.models";

export const getWallet = async (
    req: Request,
    res: Response
): Promise<void> => {

    try {
        const { userId } = req.body

        if (!userId) {
            res.status(400).json({
                message: "User ID required."
            })
            return
        }

        const wallet = await walletModel.findOne({
            ownerId: userId
        })

        if (!wallet) {
            res.status(404).json({
                message: "Wallet not found."
            })
            return
        }

        res.status(200).json({
            wallet: {
                id: wallet._id,
                balance: wallet.balance,
                currency: wallet.currency,
                status: wallet.status
            }
        })
    } catch (error) {
        console.log("Get wallet error: ", error);
        res.status(500).json({
            message: "Internal server error."
        })
    }
}


export const addMoney = async (
    req: Request,
    res: Response
): Promise<void> => {

    try {

        const { userId, amount } = req.body

        if (!userId || amount == undefined) {
            res.status(401).json({
                message: "UserId and amount both are needed."
            })
            return
        }

        if (typeof amount !== "number" || amount <= 0) {
            res.status(401).json({
                message: "Amount must be greater then 0"
            })
            return
        }

        const amountInPaisa = Math.round(amount * 100)

        const wallet = await walletModel.findOne({
            ownerId: userId
        })

        if (!wallet) {
            res.status(401).json({
                message: "Wallet not found."
            })
            return
        }

        if (wallet.status !== "active") {
            res.status(401).json({
                message: "Wallet is not active."
            })
            return
        }

        wallet.balance += amountInPaisa

        await wallet.save()

        const transaction = await transactionModel.create({
            walletID: wallet._id,
            type: "CREDIT",
            amount: amountInPaisa,
            currency: "INR",
            status: "Success",
            description: "Money added to wallet."
        })

        res.status(200).json({
            message: "Money added successfully.",

            wallet: {
                id: wallet._id,
                balance: wallet.balance,
                currency: wallet.currency
            },

            transaction:{
                id: transaction._id,
                type: transaction.type,
                amount: transaction.amount,
                status: transaction.status
            }
        })

    } catch (error) {
        console.log("Add money error: ", error);
        
        res.status(401).json({
            message: "Interval server error."
        })
    }


}
