import dotenv from "dotenv";
import express from "express"
import authRoutes from "./routes/auth.routes"
import walletRouter from "./routes/wallet.routes"
import paymentRouter from "./routes/payment.routes"

dotenv.config();

const app = express()

app.use(
    express.json({
        verify: (req, res, buf) => {
            (req as any).rawBody = buf;
        }
    })
);

app.use("/api/auth", authRoutes)
app.use("/api/wallet", walletRouter)

app.use("/api/payment", paymentRouter)

export default app
