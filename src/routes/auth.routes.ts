import express from "express"
import {registerUser} from "../controllers/auth.controllers"

const router = express.Router()

router.post("/registration", registerUser)

export default router