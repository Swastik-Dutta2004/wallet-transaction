import express from "express";
import { createOrder, verifyPayment, handleWebhook, getPaymentStatus, createRefund } from "../controllers/payment.controller";
import { authenticateUser } from "../middleware/auth.middleware";

const router = express.Router();

router.post("/create-order", authenticateUser, createOrder);
router.post("/verify", authenticateUser, verifyPayment);
router.post("/webhook", handleWebhook);
router.get("/status/:orderId", authenticateUser, getPaymentStatus);
router.post("/refund", authenticateUser, createRefund);

export default router;