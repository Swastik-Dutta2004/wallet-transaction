import mongoose from "mongoose";
import { Request, Response } from "express"
import walletModel from "../models/wallet.models"
import transactionModel from "../models/transaction.models";
import {AuthRequest} from "../middleware/auth.middleware"

export const getWallet = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    try {
        const userId = req.user?.userId;

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
    req: AuthRequest,
    res: Response
): Promise<void> => {

    const session = await mongoose.startSession()

    try {

        session.startTransaction()

        const { amount } = req.body

        // Get user ID from JWT
        const userId = req.user?.userId

        // Validate user and amount
        if (!userId || amount === undefined) {

            await session.abortTransaction()

            res.status(400).json({
                message: "User ID and amount are required."
            })

            return
        }

        // Validate amount
        if (typeof amount !== "number" || amount <= 0) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Amount must be greater than 0."
            })

            return
        }

        // Convert rupees to paise
        const amountInPaise = Math.round(amount * 100)

        // Find wallet using logged-in user's ID
        const wallet = await walletModel.findOne({
            ownerId: userId
        }).session(session)

        if (!wallet) {

            await session.abortTransaction()

            res.status(404).json({
                message: "Wallet not found."
            })

            return
        }

        // Check wallet status
        if (wallet.status !== "active") {

            await session.abortTransaction()

            res.status(400).json({
                message: "Wallet is not active."
            })

            return
        }

        // Add money to wallet
        wallet.balance += amountInPaise

        await wallet.save({ session })

        // Create transaction
        const transaction = new transactionModel({
            walletId: wallet._id,
            type: "CREDIT",
            amount: amountInPaise,
            currency: wallet.currency,
            status: "Success",
            description: "Money added to wallet."
        })

        await transaction.save({ session })

        // Commit database transaction
        await session.commitTransaction()

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

    } catch (error) {

        await session.abortTransaction()

        console.log("Add money error:", error)

        res.status(500).json({
            message: "Internal server error."
        })

    } finally {

        session.endSession()

    }
}


export const transferMoney = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    const session = await mongoose.startSession()

    try {

        session.startTransaction()

        const { receiverId, amount } = req.body

        // Get sender ID from JWT
        const senderId = req.user?.userId

        // Validate input
        if (!senderId ) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Sender ID required."
            })

            return
        }

        if ( !receiverId ) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Receiver ID required."
            })

            return
        }

        if ( amount === undefined) {

            await session.abortTransaction()

            res.status(400).json({
                message: " amount is required."
            })

            return
        }

        // Sender and receiver cannot be the same
        if (senderId === receiverId) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Sender and receiver cannot be the same."
            })

            return
        }

        // Validate amount
        if (typeof amount !== "number" || amount <= 0) {

            await session.abortTransaction()

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

            res.status(400).json({
                message: "Both wallets must be active."
            })

            return
        }

        // Check sender balance
        if (senderWallet.balance < amountInPaise) {

            await session.abortTransaction()

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

        // Create transfer transaction
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

        console.log("Transfer error:", error)

        res.status(500).json({
            message: "Internal server error."
        })

    } finally {

        session.endSession()

    }
}

