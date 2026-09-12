import express from "express"
import authRoutes from "./routes/auth.routes"
import walletRouter from "./routes/wallet.routes"

const app = express()
app.use(express.json())

app.use("/api/auth", authRoutes)
app.use("/api/wallet", walletRouter)

export default app
