import express from "express"
import {registerUser,loginUser} from "../controllers/auth.controllers"

const router = express.Router()

router.post("/registration", registerUser)

router.post("/login", loginUser)

export default router