import mongoose from "mongoose";
import { Request, Response } from "express"
import walletModel from "../models/wallet.models"
import transactionModel from "../models/transaction.models";
import { AuthRequest } from "../middleware/auth.middleware"
import ledgerModel from "../models/ledger.models"


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

        const idempotencyKey = req.headers["idempotency-key"]

        if (!idempotencyKey || typeof idempotencyKey !== "string") {

            await session.abortTransaction()

            res.status(400).json({
                message: "Idempotency-Key header is required."
            })

            return
        }


        const existingTransaction = await transactionModel.findOne({
            idempotencyKey
        }).session(session)

        if (existingTransaction) {
            await session.abortTransaction()

            res.status(200).json({
                message: "Request already processed.",
                transaction: {
                    id: existingTransaction._id,
                    type: existingTransaction.type,
                    amount: existingTransaction.amount,
                    status: existingTransaction.status
                }
            })

            return
        }


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

        const balanceBefore = wallet.balance

        wallet.balance += amountInPaise

        const balanceAfter = wallet.balance

        await wallet.save({ session })

        // Create transaction
        const transaction = new transactionModel({
            walletId: wallet._id,
            type: "CREDIT",
            amount: amountInPaise,
            currency: wallet.currency,
            idempotencyKey,
            status: "Success",
            description: "Money added to wallet."
        })
        await transaction.save({ session })

        const ledger = new ledgerModel({
            walletId: wallet._id,
            transactionId: transaction._id,
            type: "CREDIT",
            amount: amountInPaise,
            balanceBefore,
            balanceAfter,
            currency: wallet.currency,
            description: "Money added to wallet."
        })

        await ledger.save({ session })

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

        const idempotencyKey = req.headers["idempotency-key"]   

        // Get sender ID from JWT
        const senderId = req.user?.userId
        

        if (!idempotencyKey || typeof idempotencyKey !== "string") {
            await session.abortTransaction()

            res.status(400).json({
                message: "Idempotency-Key header is required."
            })

            return
        }


        // Validate input
        if (!senderId) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Sender ID required."
            })

            return
        }

        if (!receiverId) {

            await session.abortTransaction()

            res.status(400).json({
                message: "Receiver ID required."
            })

            return
        }

        if (amount === undefined) {

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

        
        const existingTransaction = await transactionModel.findOne({
            idempotencyKey
        }).session(session)


        if (existingTransaction) {
            await session.abortTransaction()

            res.status(200).json({
                message: "Request already processed.",
                transaction: {
                    id: existingTransaction._id,
                    type: existingTransaction.type,
                    amount: existingTransaction.amount,
                    status: existingTransaction.status
                }
            })

            return
        }

        const senderBalanceBefore = senderWallet.balance
        const receiverBalanceBefore = receiverWallet.balance

        senderWallet.balance -= amountInPaise
        receiverWallet.balance += amountInPaise

        const senderBalanceAfter = senderWallet.balance
        const receiverBalanceAfter = receiverWallet.balance

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
            idempotencyKey,
            status: "Success",
            description: "Wallet-to-wallet transfer"
        })

        await transaction.save({ session })


        const senderLedger = new ledgerModel({
            walletId: senderWallet._id,
            transactionId: transaction._id,
            type: "DEBIT",
            amount: amountInPaise,
            balanceBefore: senderBalanceBefore,
            balanceAfter: senderBalanceAfter,
            currency: senderWallet.currency,
            description: "Wallet-to-wallet transfer"
        })

        await senderLedger.save({ session })


        const receiverLedger = new ledgerModel({
            walletId: receiverWallet._id,
            transactionId: transaction._id,
            type: "CREDIT",
            amount: amountInPaise,
            balanceBefore: receiverBalanceBefore,
            balanceAfter: receiverBalanceAfter,
            currency: receiverWallet.currency,
            description: "Wallet-to-wallet transfer"
        })

        await receiverLedger.save({ session })

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


export const getTransactions = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {
    try {

        const userId = req.user?.userId

        if (!userId) {
            res.status(401).json({
                message: "User authentication required."
            })
            return
        }

        // Find user's wallet
        const wallet = await walletModel.findOne({
            ownerId: userId
        })

        if (!wallet) {
            res.status(404).json({
                message: "Wallet not found."
            })
            return
        }

        // Find transactions related to this wallet
        const transactions = await transactionModel
            .find({
                $or: [
                    { walletId: wallet._id },
                    { senderWalletId: wallet._id },
                    { receiverWalletId: wallet._id }
                ]
            })
            .sort({ createdAt: -1 })

        res.status(200).json({
            message: "Transactions fetched successfully.",
            transactions
        })

    } catch (error) {

        console.error("Get transactions error:", error)

        res.status(500).json({
            message: "Internal server error."
        })
    }
}
