import { Request, Response } from "express"
import user from "../models/user.models"
import Wallet from "../models/wallet.models"
const bycrpt = require("bcrypt")


export const registerUser = async (
    req: Request,
    res: Response
): Promise<void> => {
    try {
        const { name, email, password } = req.body

        if (!name || !email || !password) {
            res.status(401).json({
                message: "Name, email, password are required."
            })
        }

        const existingUser = await user.findOne({ email })

        if (existingUser) {
            res.status(401).json({
                message: "User is already exist"
            })
        }

        const hashedPassword = await bycrpt.hash(password, 10)

        const User = await user.create({
            name,
            email,
            password: hashedPassword
        })

        const wallet = await Wallet.create({
            ownerId: User._id,
            balance: 0,
            currency: "INR"
        })

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
                currecncy: wallet.currency
            }
        })
    } catch (error) {
        console.log("Registration errro: ", error)
        res.status(401).json({
            message: "Internal server error."
        })

    }
}

module.exports = { registerUser }