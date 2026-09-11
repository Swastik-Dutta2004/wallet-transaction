import mongoose, { Document, Schema } from "mongoose"

export interface IUser extends Document {
    name: string;
    email: string;
    password: string;
    role: "user" | "admin" | "merchant";
    status: "active" | "blocked" | "suspended";
    createdAt: Date;
    updatedAt: Date
}

const userSchema = new Schema < IUser > ({
    name: {
        type: String,
        required: true,
        trim: true
    },

    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },

    password: {
        type: String,
        required: true,
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

const userModel = mongoose.model < IUser > ("User", userSchema);

export default userModel