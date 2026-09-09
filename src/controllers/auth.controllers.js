const userModel = require("../models/user.models")
const WalletModel = require("../models/wallet.models")
const bycrpt = require("bcrypt")


const registration = async (req, res) => {
    try {
        const {name, email, password} = req.body

        if (!name || !email ||!password) {
            return res.status(401).json({
                message: "Name, email, password are required."
            })
        }

        const existingUser = await userModel.findOne({email})

        if (existingUser) {
            return res.status(401).json({
                message: "User is already exist"
            })
        }

        const hashedPassword = await bycrpt.hash(password, 10)

        const User = await userModel.create({
            name,
            email,
            password: hashedPassword
        })

        const wallet = await WalletModel.create({
            ownerId : User._id,
            balance: 0,
            currecncy: "INR"
        })

        return res.status(200).json({
            message: "User registered successfully.",
            user: {
                id: User._id,
                name: User.name,
                email: User.email
            },
            wallet: {
                id: wallet._id,
                balance: wallet.balance,
                currecncy: wallet.currecncy
            }
        })
    } catch (error) {
        console.log("Registration errro: ", error)
        return res.status(401).json({
            message: "Internal server error."
        })
            
    }
}

module.exports = {registration}