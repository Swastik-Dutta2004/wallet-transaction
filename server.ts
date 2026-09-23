import dotenv from "dotenv";
dotenv.config();

import app from "./src/app";
import connectDB from "./src/config/db";

const PORT = process.env.PORT || 3000;

const startServer = async (): Promise<void> => {

    try {
        await connectDB();

        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
        
    } catch (error) {
        console.error("Database connection failed:", error);
        process.exit(1);
    }
};

startServer();
