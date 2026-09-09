    require("dotenv").config();
    const mongoose = require("mongoose");

    const connectDB = async () => {
        try {
            await mongoose.connect(process.env.MONGO_URL) 

            console.log("Databae is connected.");
            
        } catch (error) {
            console.log("Database is not connected.", error.message);
            process.exit(1)
            
        }
    };


    module.exports = connectDB
