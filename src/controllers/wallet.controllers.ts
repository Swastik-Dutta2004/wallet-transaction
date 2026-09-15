import mongoose from "mongoose";
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

    const sessions = await mongoose.startSession()

    try {

        sessions.startTransaction()

        const { userId, amount } = req.body

        if (!userId || amount == undefined) {

            await sessions.abortTransaction()
            sessions.endSession()

            res.status(401).json({
                message: "UserId and amount both are needed."
            })
            return
        }

        if (typeof amount !== "number" || amount <= 0) {

            await sessions.abortTransaction()
            sessions.endSession()

            res.status(401).json({
                message: "Amount must be greater then 0"
            })
            return
        }

        const amountInPaisa = Math.round(amount * 100)

        const wallet = await walletModel.findOne({
            ownerId: userId
        }).session(sessions)

        if (!wallet) {

            await sessions.abortTransaction()
            sessions.endSession()

            res.status(401).json({
                message: "Wallet not found."
            })
            return
        }

        if (wallet.status !== "active") {

            await sessions.abortTransaction()
            sessions.endSession()

            res.status(401).json({
                message: "Wallet is not active."
            })
            return
        }

        wallet.balance += amountInPaisa

        await wallet.save({ session: sessions })

        const [transaction] = await transactionModel.create(
            [
                {
                    walletId: wallet._id,
                    type: "CREDIT",
                    amount: amountInPaisa,
                    currency: "INR",
                    status: "Success",
                    description: "Money added to wallet."
                }
            ],
            { session: sessions }
        )

        res.status(200).json({
            message: "Money added successfully.",

            wallet: {
                id: wallet._id,
                balance: wallet.balance,
                currency: wallet.currency
            },

            transaction: {
                id: transaction._id,
                type: transaction.type,
                amount: transaction.amount,
                status: transaction.status
            }
        })

        await sessions.commitTransaction()

    } catch (error) {

        await sessions.abortTransaction()

        console.log("Add money error: ", error);

        res.status(401).json({
            message: "Interval server error."
        })
    }

    finally {
        sessions.endSession()

    }


}


export const transferMoney = async (
    req: Request,
    res: Response
): Promise<void> => {

    const session = await mongoose.startSession()

    try {

        session.startTransaction()

        const { senderId, receiverId, amount } = req.body

        // Validate input
        if (!senderId || !receiverId || amount === undefined) {

            await session.abortTransaction()
            session.endSession()

            res.status(400).json({
                message: "Sender ID, receiver ID and amount are required."
            })

            return
        }

        // Sender and receiver cannot be the same
        if (senderId === receiverId) {

            await session.abortTransaction()
            session.endSession()

            res.status(400).json({
                message: "Sender and receiver cannot be the same."
            })

            return
        }

        // Validate amount
        if (typeof amount !== "number" || amount <= 0) {

            await session.abortTransaction()
            session.endSession()

            res.status(400).json({
                message: "Amount must be greater than 0."
            })

            return
        }

        // Convert rupees to paise
        const amountInPaise = Math.round(amount * 100)

        // Find sender wallet
        const senderWallet = await walletModel.findOne({
            ownerId: senderId
        }).session(session)

        if (!senderWallet) {

            await session.abortTransaction()
            session.endSession()

            res.status(404).json({
                message: "Sender wallet not found."
            })

            return
        }

        // Find receiver wallet
        const receiverWallet = await walletModel.findOne({
            ownerId: receiverId
        }).session(session)

        if (!receiverWallet) {

            await session.abortTransaction()
            session.endSession()

            res.status(404).json({
                message: "Receiver wallet not found."
            })

            return
        }

        // Check wallet status
        if (
            senderWallet.status !== "active" ||
            receiverWallet.status !== "active"
        ) {

            await session.abortTransaction()
            session.endSession()

            res.status(400).json({
                message: "Both wallets must be active."
            })

            return
        }

        // Check sender balance
        if (senderWallet.balance < amountInPaise) {

            await session.abortTransaction()
            session.endSession()

            res.status(400).json({
                message: "Insufficient wallet balance."
            })

            return
        }

        // Debit sender
        senderWallet.balance -= amountInPaise

        // Credit receiver
        receiverWallet.balance += amountInPaise

        // Save both wallets
        await senderWallet.save({ session })
        await receiverWallet.save({ session })

        // Create transaction
        const transaction = new transactionModel({
            senderWalletId: senderWallet._id,
            receiverWalletId: receiverWallet._id,
            type: "TRANSFER",
            amount: amountInPaise,
            currency: senderWallet.currency,
            status: "Success",
            description: "Wallet-to-wallet transfer"
        })

        await transaction.save({ session })

        // Commit transaction
        await session.commitTransaction()
        session.endSession()

        res.status(200).json({

            message: "Money transferred successfully.",

            transfer: {
                transactionId: transaction._id,
                amount: transaction.amount,
                currency: transaction.currency,
                status: transaction.status
            },

            senderWallet: {
                id: senderWallet._id,
                balance: senderWallet.balance
            },

            receiverWallet: {
                id: receiverWallet._id,
                balance: receiverWallet.balance
            }
        })

    } catch (error) {

        await session.abortTransaction()
        session.endSession()

        console.log("Transfer error:", error)

        res.status(500).json({
            message: "Internal server error."
        })
    }
}