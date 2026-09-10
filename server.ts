import dotenv from "dotenv"
import app from "./src/app"
import connectDB from "./src/config"

dotenv.config()

const PORT = process.env.PORT || 3000

const startServer = async (): Promise<void> => {
    try {
        app.listen(PORT, () => {
            console.log(`Server is running on port no. ${PORT}`);
        })
    } catch (error) {
        console.log("Database connection failed for: ", error);
        
    }
}

startServer()