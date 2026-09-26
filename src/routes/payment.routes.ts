import express from "express";
import { createOrder, verifyPayment, handleWebhook} from "../controllers/payment.controller";
import { authenticateUser } from "../middleware/auth.middleware";

const router = express.Router();

router.post("/create-order", authenticateUser, createOrder);
router.post("/verify", authenticateUser, verifyPayment);
router.post("/webhook", handleWebhook);

export default router;