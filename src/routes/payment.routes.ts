import express from "express";
import { createOrder, verifyPayment } from "../controllers/payment.controller";
import { authenticateUser } from "../middleware/auth.middleware";

const router = express.Router();

router.post("/create-order", authenticateUser, createOrder);
router.post("/verify", authenticateUser, verifyPayment);

export default router;