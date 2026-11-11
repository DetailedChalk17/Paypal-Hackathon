import { createContext, useContext } from "react";
import type { User } from "./api/client";

type AuthContextValue = {
  user: User | null;
  openSignIn: (role?: User["role"]) => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside the app shell.");
  return context;
}
