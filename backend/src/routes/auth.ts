import { Router } from "express";
import { generateToken, authMiddleware, AuthRequest } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";

const router = Router();
const log = createLogger('auth');

/**
 * Signup is disabled — members are created in Twenty, not in the dialer.
 */
router.post("/signup", (_req, res) => {
  res.status(403).json({
    error:
      "Sign up is disabled. Create the member in Twenty, then sign in with Twenty SSO.",
  });
});

router.get("/me", authMiddleware, (req: AuthRequest, res) => {
  // User info is stored in the JWT token payload
  const user = {
    id: req.userId!,
    email: req.userEmail || "",
    fullName: req.userFullName || "",
    role: "agent",
    twentyUserId: req.twentyUserId,
  };

  log.info(`GET /me: ${user.email}`);
  res.json(user);
});

export default router;
