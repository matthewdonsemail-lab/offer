import { Pool } from "pg";
import bcrypt from "bcryptjs";

let pool: Pool | null = null;

export type TwentyUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isEmailVerified: boolean;
};

export interface TwentyPgStatus {
  configured: boolean;
  message: string;
}

export function getTwentyPgStatus(): TwentyPgStatus {
  const url = process.env.TWENTY_DATABASE_URL;
  if (!url) {
    return {
      configured: false,
      message: "TWENTY_DATABASE_URL is not set — Twenty credential verification is disabled.",
    };
  }
  return {
    configured: true,
    message: "Configured to connect to Twenty Postgres",
  };
}

function getPool(): Pool | null {
  if (pool) return pool;

  const connectionString = process.env.TWENTY_DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  try {
    pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 30_000 });
    pool.on("error", (err) => console.error("[twenty-pg] pool error:", err));
  } catch (err) {
    console.error("[twenty-pg] failed to create pool:", err);
    return null;
  }

  return pool;
}

/**
 * Verify an email/password pair against Twenty's `core."user"` table.
 */
export async function verifyTwentyUser(
  email: string,
  password: string,
): Promise<TwentyUser | null> {
  const pool = getPool();
  if (!pool) {
    throw new Error(
      "Server is not configured to verify Twenty credentials. " +
      "Set TWENTY_DATABASE_URL to the read-only Postgres connection " +
      "for your Twenty instance.",
    );
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) return null;

  try {
    console.log(`[twenty-pg] verifying email=${normalizedEmail} (original len=${email.length})`);
    const res = await pool.query(
      `SELECT id, email, "passwordHash", "firstName", "lastName",
              "isEmailVerified", disabled
       FROM core."user"
       WHERE email = LOWER($1) AND "deletedAt" IS NULL`,
      [normalizedEmail],
    );

    console.log(`[twenty-pg] query returned ${res.rows.length} rows for ${normalizedEmail} — full row JSON (passwordHash redacted):`, JSON.stringify(res.rows.map(r => ({ ...r, passwordHash: r.passwordHash ? `***hash len ${r.passwordHash.length}` : null })), null, 2));
    const row = res.rows[0];
    if (!row) {
      console.warn(`[twenty-pg] no user found for ${normalizedEmail}`);
      return null;
    }
    if (!row.passwordHash) {
      console.warn(`[twenty-pg] user ${normalizedEmail} has no passwordHash`);
      return null;
    }
    if (row.disabled) {
      console.warn(`[twenty-pg] user ${normalizedEmail} is disabled`);
      return null;
    }

    const ok = await bcrypt.compare(password, row.passwordHash);
    console.log(`[twenty-pg] bcrypt.compare for ${normalizedEmail} => ${ok}`);
    return ok
      ? {
          id: row.id,
          email: row.email,
          firstName: row.firstName ?? null,
          lastName: row.lastName ?? null,
          isEmailVerified: !!row.isEmailVerified,
        }
      : null;
  } catch (error) {
    console.error("[twenty-pg] query error:", error);
    return null;
  }
}

/**
 * Look up an active Twenty user by id or email (OAuth sign-in: the token proves
 * who signed in, this resolves the display identity). Null when not found or
 * when Twenty Postgres is not configured.
 */
export async function findTwentyUser(
  by: { id?: string; email?: string },
): Promise<TwentyUser | null> {
  const pool = getPool();
  if (!pool || (!by.id && !by.email)) return null;
  try {
    const res = by.id
      ? await pool.query(
          `SELECT id, email, "firstName", "lastName", "isEmailVerified"
           FROM core."user" WHERE id = $1 AND "deletedAt" IS NULL AND NOT disabled`,
          [by.id],
        )
      : await pool.query(
          `SELECT id, email, "firstName", "lastName", "isEmailVerified"
           FROM core."user" WHERE email = LOWER($1) AND "deletedAt" IS NULL AND NOT disabled`,
          [by.email!.trim()],
        );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      firstName: row.firstName ?? null,
      lastName: row.lastName ?? null,
      isEmailVerified: !!row.isEmailVerified,
    };
  } catch (error) {
    console.error("[twenty-pg] findTwentyUser error:", error);
    return null;
  }
}

export async function closeTwentyPg(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
