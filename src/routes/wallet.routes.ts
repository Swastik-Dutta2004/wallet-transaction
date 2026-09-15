import express from "express"
import {
    getWallet,
    addMoney,
    transferMoney
} from "../controllers/wallet.controllers"
import {authenticateUser} from "../middleware/auth.middleware"

const router = express.Router()

router.get("/get-wallet", authenticateUser, getWallet)

router.post("/add-money", authenticateUser, addMoney)

router.post("/transfer-money", authenticateUser, transferMoney)

export default router