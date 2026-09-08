import { createContext, useContext } from "react";
import type { User } from "./api.ts";

export const SessionContext = createContext<User | null>(null);

export function useSession(): User {
  const user = useContext(SessionContext);
  if (!user) throw new Error("useSession called outside a signed-in shell");
  return user;
}
