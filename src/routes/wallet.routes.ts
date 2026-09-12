import express from "express"
import {getWallet, addMoney} from "../controllers/wallet.controllers"

const router = express.Router()

router.get("/", getWallet)
router.post("/add-money", addMoney)

export default router