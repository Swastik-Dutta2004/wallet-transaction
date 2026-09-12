import mongoose from "mongoose"
import { Request, Response } from "express"
import userModel from "../models/user.models"
import walletModel from "../models/wallet.models"
import bcrypt from "bcrypt"


export const registerUser = async (
    req: Request,
    res: Response
): Promise<void> => {

    const { name, email, password } = req.body

    if (!name || !email || !password) {
        res.status(400).json({
            message: "Name, email, password are required."
        })
        return
    }

    const existingUser = await userModel.findOne({ email })

    if (existingUser) {

        res.status(409).json({
            message: "User already exists"
        })
        return
    }

    const session = await mongoose.startSession()

    try {

        session.startTransaction()

        const hashedPassword = await bcrypt.hash(password, 10)

        const [User] = await userModel.create(
            [
                {
                    name,
                    email,
                    password: hashedPassword
                }
            ],
            { session }
        )

        const [wallet] = await walletModel.create(
            [
                {
                    ownerId: User._id,
                    balance: 0,
                    currency: "INR"
                }
            ],
            { session }
        )

        await session.commitTransaction()

        res.status(200).json({
            message: "User registered successfully.",
            user: {
                id: User._id,
                name: User.name,
                email: User.email
            },
            wallet: {
                id: wallet._id,
                balance: wallet.balance,
                currency: wallet.currency
            }
        })
    } catch (error) {

        await session.abortTransaction()

        console.log("Registration error: ", error)

        res.status(500).json({
            message: "Internal server error."
        })

    }
    
    finally{
        session.endSession()
    }
}
