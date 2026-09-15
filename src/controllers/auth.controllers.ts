import mongoose from "mongoose"
import { Request, Response } from "express"
import userModel from "../models/user.models"
import walletModel from "../models/wallet.models"
import bcrypt from "bcrypt"
import { AuthRequest } from "../middleware/auth.middleware"
import jwt from "jsonwebtoken"


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

    finally {
        session.endSession()
    }
}


export const loginUser = async (
    req: Request,
    res: Response
): Promise<void> => {
    try {
        const { email, password } = req.body

        if (!email || !password) {
            res.status(400).json({
                message: "Email and password are required"
            });
            return;
        }

        const findUser = await userModel.findOne({ email })

        if (!findUser) {
            res.status(401).json({
                message: "Email ID not found."
            });
            return;
        }

        const isCorrectPassword = await bcrypt.compare(
            password,
            findUser.password
        )

        if (!isCorrectPassword) {
            res.status(401).json({
                message: "Given wrong password."
            });
            return;
        }

        if (findUser.status !== "active") {
            res.status(403).json({
                message: "User account is not active"
            });
            return;
        }

        const secret = process.env.JWT_SECRET;

        if (!secret) {
            res.status(500).json({
                message: "JWT secret is not configured"
            });
            return;
        }


        const token = jwt.sign(
            {
                userId: findUser._id.toString()
            },
            secret,
            {
                expiresIn: "1d"
            }
        )

        res.status(200).json({
            message: "Login successful",
            token,
            userModel: {
                id: findUser._id,
                name: findUser.name,
                email: findUser.email,
                role: findUser.role
            }

        })
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({
            message: "Internal server error"
        });
    }
}