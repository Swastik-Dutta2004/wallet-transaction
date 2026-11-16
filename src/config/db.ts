import mongoose from "mongoose"

const connectDB = async (): Promise<void> => {
    const mongoURL = process.env.MONGO_URL

    if (!mongoURL) {
        throw new Error("MongoDB uri is not defined in .env file")
    }

    // Let connection failures propagate. server.ts catches them and exits,
    // so the API never starts listening without a database.
    await mongoose.connect(mongoURL)

    console.log("Database is connected successfully.")
}

export default connectDB