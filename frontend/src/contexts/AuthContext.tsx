"use client";

import React, { createContext, useContext, useState } from "react";
import { AuthUser } from "@/lib/types";

interface AuthContextValue {
  user: AuthUser | null;
  login: (user: AuthUser) => void;
  logout: () => void;
  isLoggedIn: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Mock customer for demo purposes
export const MOCK_CUSTOMER: AuthUser = {
  id: "cust-1",
  email: "ivan.petrov@example.com",
  firstName: "Иван",
  lastName: "Петров",
  role: "customer",
  accountType: "personal",
  discountPercent: 0,
};

export const MOCK_ADMIN: AuthUser = {
  id: "admin-1",
  email: "admin@shop.bg",
  firstName: "Администратор",
  lastName: "",
  role: "admin",
  discountPercent: 0,
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);

  const login = (u: AuthUser) => setUser(u);
  const logout = () => setUser(null);

  return (
    <AuthContext.Provider value={{ user, login, logout, isLoggedIn: user !== null }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
