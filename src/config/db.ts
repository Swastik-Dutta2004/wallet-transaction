import mongoose from "mongoose"

const connectDB = async(): Promise<void> => {
    try {
        const mongoURL = process.env.MONGO_URL

        if (!mongoURL) {
            throw new Error("MongoDB uri is not defined in .env file");
            
        }
        await mongoose.connect(mongoURL)
        console.log("Database is connected successfully.");
        
        
    } catch (error) {
        console.log("Database connection failed: ", error);
        
    }
}

export default connectDB