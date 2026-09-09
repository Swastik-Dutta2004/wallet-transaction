const mongoose = require('mongoose')

const userSchema = new mongoose.Schema({
    name :{
        type: String,
        required: true,
        trim: true
    },

    email: {
        type: String,
        require: true,
        unique: true,
        lowecase: true,
        trim: true
    },

    password: {
        type: String,
        require: true,
    },

    role: {
        type: String,
        enum: ["user", "admin", "merchant"],
        default: "user" 
    },

    status: {
        type: String,
        enum: ["active", "blocked", "suspended"],
        default: "active"
    },

},
    {
        timestamps: true,
    },
)

const userModule = mongoose.model("User", userSchema)

module.exports = userModule