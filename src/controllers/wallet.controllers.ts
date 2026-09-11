import { Request, Response } from "express"
import walletModel from "../models/wallet.models"

export const getWallet = async (
    req: Request,
    res: Response
): Promise<void> => {

    try {
        const {userId} = req.body

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
        console.log("Get wallet error: ",error);
        res.status(500).json({
            message: "Internal server error."
        })        
    }
}