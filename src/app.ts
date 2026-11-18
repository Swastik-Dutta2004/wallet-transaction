import dotenv from "dotenv";

// Load .env before importing any route/controller: payment.controller creates
// the Razorpay client at module load, and wallet.controllers derives
// directCreditEnabled at module load as well. Both must see real values.
dotenv.config();

import express, { NextFunction, Request, Response } from "express"
import authRoutes from "./routes/auth.routes"
import walletRouter from "./routes/wallet.routes"
import paymentRouter from "./routes/payment.routes"

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

    // body-parser tags its own failures with a `type` field. Using it is
    // more reliable than a bare `instanceof SyntaxError`, which would also
    // catch unrelated programming errors and mislabel them as a 400.
    const bodyParserError = error as
        | { type?: string; status?: number }
        | null
        | undefined

    if (bodyParserError?.type === "entity.parse.failed") {
        res.status(400).json({
            message: "Invalid JSON body."
        })
        return
    }

    // Payloads above the configured json body limit.
    if (bodyParserError?.type === "entity.too.large") {
        res.status(413).json({
            message: "Request body is too large."
        })
        return
    }

    // Older/other body-parser versions surface malformed JSON as a
    // SyntaxError carrying the raw `body` property. Keep this as a fallback.
    if (
        error instanceof SyntaxError &&
        bodyParserError?.status === 400 &&
        "body" in error
    ) {
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
