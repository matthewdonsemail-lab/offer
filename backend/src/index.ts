import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

// Load environment variables from project root .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../../.env.local");
const result = config({ path: envPath });
if (result.error) {
  console.warn("[env] failed to load .env.local:", result.error.message);
} else {
  console.log("[env] loaded from", envPath);
}

import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import oauthRoutes from "./routes/oauth.js";
import offersRoutes from "./routes/offers.js";
import prospectsRoutes from "./routes/prospects.js";
import industriesRoutes from "./routes/industries.js";
import leadsRoutes from "./routes/leads.js";
import publicRoutes from "./routes/public.js";
import { getTwentyPgStatus } from "./db/twenty-pg.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger('server');

/**
 * Build the Express app without binding a port, so the same code runs under
 * `tsx watch` locally and as a Vercel serverless function (see /api/index.ts).
 */
export function createApp() {
  const app = express();

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  // Request logger — prints method, url, body JSON, and response time
  app.use((req, _res, next) => {
    const start = Date.now();
    const sanitizedBody = { ...req.body };
    if (sanitizedBody.password) sanitizedBody.password = `***(${String(sanitizedBody.password).length} chars)`;
    console.log(`[http] --> ${req.method} ${req.url} body=${JSON.stringify(sanitizedBody)}`);
    // log on finish
    _res.on('finish', () => {
      console.log(`[http] <-- ${req.method} ${req.url} ${_res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  app.get("/api/health", (_req, res) => {
    const twentyPg = getTwentyPgStatus();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      twentyCrm: {
        apiKeyConfigured: Boolean(process.env.TWENTY_API_KEY),
        databaseUrlConfigured: twentyPg.configured,
        databaseMessage: twentyPg.message,
      },
    });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/oauth", oauthRoutes);
  app.use("/api/offers", offersRoutes);
  app.use("/api/prospects", prospectsRoutes);
  app.use("/api/industries", industriesRoutes);
  app.use("/api/leads", leadsRoutes);
  // Unauthenticated public funnel surface (offer.domain.com) — visual payloads + lead capture only
  app.use("/api/public", publicRoutes);

  // Log whether Twenty Postgres is available for login
  const twentyPgStatus = getTwentyPgStatus();
  if (!twentyPgStatus.configured) {
    log.warn("[auth] Twenty credential verification is unavailable:", twentyPgStatus.message);
  } else {
    log.info("[auth] Twenty credential verification is configured.");
  }

  return app;
}

// Bind a port only when run directly (tsx watch / node dist/index.js).
// Imported by /api/index.ts on Vercel, where the platform invokes the app.
const isDirectRun =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const PORT = parseInt(process.env.PORT || "4000", 10);
  const app = createApp();
  log.info(`Server running on http://localhost:${PORT}`);
  app.listen(PORT, "0.0.0.0", () => {
    log.info(`Server ready on port ${PORT}`);
  });
}
