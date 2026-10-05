import { Router } from "express";
import { generateToken } from "../middleware/auth.js";
import { findTwentyUser } from "../db/twenty-pg.js";
import { createLogger } from "../lib/logger.js";
import {
  TwentyOAuthError,
  decodeJwtPayload,
  discoverOAuth,
  exchangeCode,
  guardedFetch,
  introspectToken,
  refreshAccessToken,
  type TwentyAccessTokenClaims,
} from "../lib/twenty/oauth.js";

const router = Router();
const log = createLogger("oauth");

/**
 * Operator sign-in against Twenty (Twenty is the identity provider).
 * Mirrors open-twenty-dialer's /api/oauth: the SPA runs PKCE, this proxy
 * redeems the code (so Twenty's CORS never matters), and POST /session turns
 * a live Twenty token into an Offer JWT so every authMiddleware route is untouched.
 */

function config() {
  const baseUrl = process.env.TWENTY_BASE_URL;
  const clientId = process.env.TWENTY_OAUTH_CLIENT_ID;
  const redirectUri = process.env.TWENTY_OAUTH_REDIRECT_URI;
  if (!baseUrl || !clientId || !redirectUri) return null;
  return {
    baseUrl,
    clientId,
    redirectUri,
    scope: process.env.TWENTY_OAUTH_SCOPE ?? "api profile",
    // Public PKCE client: never send a secret (see lib/twenty/oauth.ts header).
    auth: { clientId, clientSecret: null },
  };
}

function fail(res: any, error: unknown, fallback: string) {
  if (error instanceof TwentyOAuthError) {
    log.error(`${fallback}:`, error.message);
    res.status(error.status >= 500 ? 502 : error.status).json({ error: fallback, detail: error.message });
    return;
  }
  log.error(fallback, error instanceof Error ? error.message : String(error));
  res.status(502).json({ error: fallback });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get("/config", async (_req, res) => {
  const cfg = config();
  if (!cfg) {
    res.status(500).json({ error: "Twenty OAuth is not configured" });
    return;
  }
  try {
    const endpoints = await discoverOAuth(cfg.baseUrl, guardedFetch);
    res.json({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      scope: cfg.scope,
    });
  } catch (error) {
    fail(res, error, "Failed to read Twenty OAuth discovery");
  }
});

router.post("/token", async (req, res) => {
  const cfg = config();
  if (!cfg) {
    res.status(500).json({ error: "Twenty OAuth is not configured" });
    return;
  }
  const { code, verifier } = req.body ?? {};
  if (!code || !verifier) {
    res.status(400).json({ error: "code and verifier are required" });
    return;
  }
  try {
    const endpoints = await discoverOAuth(cfg.baseUrl, guardedFetch);
    // redirect_uri is server-owned: it must equal the one the authorize step used.
    const tokens = await exchangeCode(
      endpoints.tokenEndpoint,
      { code, verifier, redirectUri: cfg.redirectUri, auth: cfg.auth },
      guardedFetch,
    );
    res.json({ tokens });
  } catch (error) {
    fail(res, error, "Failed to exchange the authorization code");
  }
});

router.post("/refresh", async (req, res) => {
  const cfg = config();
  if (!cfg) {
    res.status(500).json({ error: "Twenty OAuth is not configured" });
    return;
  }
  if (!req.body?.refreshToken) {
    res.status(400).json({ error: "refreshToken is required" });
    return;
  }
  try {
    const endpoints = await discoverOAuth(cfg.baseUrl, guardedFetch);
    const tokens = await refreshAccessToken(
      endpoints.tokenEndpoint,
      { refreshToken: req.body.refreshToken, auth: cfg.auth },
      guardedFetch,
    );
    res.json({ tokens });
  } catch (error) {
    fail(res, error, "Failed to refresh the token");
  }
});

/** Introspect a live Twenty token, resolve the human, mint an Offer JWT. */
router.post("/session", async (req, res) => {
  const cfg = config();
  if (!cfg) {
    res.status(500).json({ error: "Twenty OAuth is not configured" });
    return;
  }
  const accessToken: string | undefined = req.body?.accessToken;
  if (!accessToken) {
    res.status(400).json({ error: "accessToken is required" });
    return;
  }
  try {
    const endpoints = await discoverOAuth(cfg.baseUrl, guardedFetch);
    if (!endpoints.introspectionEndpoint) {
      throw new TwentyOAuthError(502, "Twenty publishes no introspection endpoint");
    }
    const result = await introspectToken(
      endpoints.introspectionEndpoint,
      { token: accessToken, auth: cfg.auth },
      guardedFetch,
    );
    if (!result.active) {
      res.status(401).json({ error: "Token is not active" });
      return;
    }

    // Twenty has no userinfo endpoint: introspection proved the token is live,
    // the JWT's userId (or an email-shaped claim) says who it is.
    let user = null;
    try {
      const claims = decodeJwtPayload<TwentyAccessTokenClaims>(accessToken);
      if (claims.userId) user = await findTwentyUser({ id: claims.userId });
    } catch {
      /* fall through to email claims */
    }
    if (!user) {
      for (const value of Object.values(result.claims)) {
        if (typeof value === "string" && EMAIL_RE.test(value.trim())) {
          user = await findTwentyUser({ email: value });
          if (user) break;
        }
      }
    }
    if (!user) {
      res.status(403).json({
        error: "Your Twenty account could not be matched to a user. Ask a workspace admin to confirm you have access.",
      });
      return;
    }

    const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
    log.info(`OAuth session minted for: ${user.email}`);
    const token = generateToken({ userId: user.id, twentyUserId: user.id, email: user.email, fullName });
    res.json({ user: { id: user.id, email: user.email, fullName, role: "agent" }, token });
  } catch (error) {
    fail(res, error, "Failed to create the session");
  }
});

export default router;
