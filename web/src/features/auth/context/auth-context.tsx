"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setAuthToken } from "@/lib/axios";
import type { AuthSession, AuthUser } from "@/types/auth";

type AuthStatus = "authenticated" | "unauthenticated";

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  status: AuthStatus;
  setSession: (session: AuthSession | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(null);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      token: session?.token ?? null,
      status: session ? "authenticated" : "unauthenticated",
      setSession: (nextSession) => {
        setAuthToken(nextSession?.token ?? null);
        setSessionState(nextSession);
      },
    }),
    [session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return context;
}
