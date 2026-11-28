export type UserRole = "user" | "admin" | "merchant";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role?: UserRole;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
}

export interface LoginResponse {
  message: string;
  token: string;
  userModel: AuthUser;
}

export interface RegisterResponse {
  message: string;
  user: Pick<AuthUser, "id" | "name" | "email">;
  wallet: {
    id: string;
    balance: number;
    currency: string;
  };
}
