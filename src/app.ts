import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express"
import authRoutes from "./routes/auth.routes"
import walletRouter from "./routes/wallet.routes"
import paymentRouter from "./routes/payment.routes"

dotenv.config();

const app = express()

// Do not advertise the framework in response headers.
app.disable("x-powered-by")

// Keep the raw body around for webhook HMAC verification. Razorpay signs the
// exact bytes it sent, so the parsed JSON must not be used in its place.
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

// Unknown routes return JSON instead of Express's default HTML 404 page.
app.use((req: Request, res: Response) => {
    res.status(404).json({
        message: "Route not found."
    })
})

// Centralised error handler. It must stay last and keep all four arguments
// so Express recognises it as an error handler.
app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {

    // body-parser wraps malformed JSON in a SyntaxError. Answer 400 instead
    // of letting it look like an internal server error.
    if (error instanceof SyntaxError) {
        res.status(400).json({
            message: "Invalid JSON body."
        })
        return
    }

    console.error("Unhandled error:", error)

    res.status(500).json({
        message: "Internal server error."
    })
})

export default app
