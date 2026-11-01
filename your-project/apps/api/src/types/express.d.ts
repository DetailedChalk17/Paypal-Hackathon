
import type { User } from "@your-project/shared";

declare global {
  namespace Express {
    interface Request {
      user?: Pick<User, "id" | "name" | "email" | "role">;
    }
  }
}

export {};
