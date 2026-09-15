import express from "express"
import {
    getWallet,
    addMoney,
    transferMoney
} from "../controllers/wallet.controllers"

const router = express.Router()

router.get("/", getWallet)

router.post("/add-money", addMoney)

router.post("/transfer-money", transferMoney)

export default router