import { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"

interface JwtPayload {
    userId: string
}

export interface AuthRequest extends Request { user?: JwtPayload; }

export const authenticateUser = (
    req: AuthRequest,
    res: Response,
    next: NextFunction
): void => {
    try {
        const authHeader = req.headers.authorization

        if (!authHeader) {  
            res.status(401).json({
                message: "Authorization token is required"
            })
            return
        }

        const token = authHeader.split(" ")[1]

        if (!token) {
            res.status(401).json({
                message: "Invalid authorization format"
            })
            return
        }

        const secret = process.env.JWT_SECRET

        if (!secret) {
            res.status(500).json({
                message: "JWT secret is not configured"
            })
            return
        }

        const decoded = jwt.verify(token, secret) as JwtPayload

        req.user = decoded

        next();
    } catch (error) {
        res.status(401).json({
            message: "Invalid or expired token"
        });

    }
}