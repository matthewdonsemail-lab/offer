/**
 * Twenty OAuth 2.0 client (authorization code + PKCE, refresh, introspect).
 *
 * Twenty is its own OAuth provider — see
 * `{TWENTY_BASE_URL}/.well-known/oauth-authorization-server` for RFC 7591
 * dynamic registration, S256 PKCE, and the `api` / `profile` scopes.
 * Ported from open-twenty-dialer (`packages/shared/src/oauth.ts`) so Offer
 * signs operators in exactly the way the dialer and blaster do.
 *
 * The client is PUBLIC: `token_endpoint_auth_method: none`. That is not a
 * shortcut. A confidential client makes the token endpoint authenticate the
 * *client*, and Twenty then answers with an APPLICATION_ACCESS token with no
 * human in it — sign-in appears to work and every record gets attributed to
 * the application actor. The dialer's docs/identity.md documents that
 * failure; the reason we keep a client secret unused is the same reason.
 *
 * Runtime requirements: global fetch and WebCrypto only. No OAuth library.
 *
 * NOTE ON SHARED CODE: the browser needs four of these helpers
 * (generateCodeVerifier, generateState, codeChallengeForVerifier,
 * buildAuthorizeUrl). The dialer solves that with a `packages/shared`
 * workspace; Offer has no such package, so the browser subset is hand-mirrored
 * at `frontend/src/lib/twenty-oauth.ts`. If you change anything in the PKCE
 * or authorize-URL section below, change it there too.
 */

export class TwentyOAuthError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Twenty OAuth ${status}: ${detail}`);
    this.name = "TwentyOAuthError";
    this.status = status;
  }
}

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  introspectionEndpoint: string | null;
  revocationEndpoint: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
}

export interface Introspection {
  active: boolean;
  username: string | null;
  /** RFC 7662 subject. For Twenty application tokens this is the application id. */
  sub: string | null;
  scope: string | null;
  expiresAt: number | null;
  /** The raw RFC 7662 response, unfiltered. */
  claims: Record<string, unknown>;
}

export interface TwentyAccessTokenClaims {
  sub?: string;
  applicationId?: string;
  workspaceId?: string;
  userId?: string;
  userWorkspaceId?: string;
  type?: string;
  exp?: number;
  iat?: number;
  /**
   * Twenty adds claims to this token over time, so the shape is open. An
   * index signature is what lets the interface satisfy `Record<string, unknown>`
   * — a `type` alias would too, but the codebase uses interfaces throughout.
   */
  [claim: string]: unknown;
}

type FetchFn = typeof fetch;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * The auth-guard sits in front of `twenty.inferencesaver.com` and gates the
 * OAuth surface specifically: `/metadata` answers unauthenticated, but
 * `/.well-known/oauth-authorization-server` returns 401 without credentials.
 * So every call in this module needs both of the headers below, and omitting
 * either one fails in a way that looks like a broken OAuth server:
 *
 *  - a browser `User-Agent`. Without it Cloudflare answers **error 1010**
 *    ("banned based on your browser's signature") and a bare 401, which reads
 *    as a bad client registration rather than a WAF rule.
 *  - HTTP Basic from TWENTY_BASIC_USER / TWENTY_BASIC_PASSWORD, the same pair
 *    open-twenty-dialer uses (dialer's docs/identity.md records "401 at
 *    /authorize -> basic creds for the auth-guard are wrong").
 *
 * Basic is sent to Twenty itself and is unrelated to the OAuth client, which
 * stays public (`token_endpoint_auth_method: none`).
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Headers the auth-guard requires, or an empty object when unconfigured. */
export function authGuardHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": BROWSER_USER_AGENT };
  const user = env.TWENTY_BASIC_USER;
  const password = env.TWENTY_BASIC_PASSWORD;
  if (user && password) {
    const encoded = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
    headers.Authorization = `Basic ${encoded}`;
  }
  return headers;
}

/**
 * Default transport: global fetch plus the auth-guard headers. Never log the
 * Authorization value — `authGuardHeaders` output is not safe to print.
 */
export const guardedFetch: FetchFn = (input, init) => {
  const headers: Record<string, string> = { ...authGuardHeaders(), ...(init?.headers as Record<string, string> | undefined) };
  return fetch(input, { ...init, headers });
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * base64url without padding, from raw bytes. Hand-rolled so the browser
 * mirror needs no runtime globals: no `btoa`, no `Buffer`.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "";
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Decode a JWT payload AFTER Twenty introspection has established the token
 * is live. This does not verify the signature — Twenty publishes no JWKS, so
 * introspection is the trust boundary and there is nothing to verify against.
 */
export function decodeJwtPayload<T extends Record<string, unknown>>(token: string): T {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TwentyOAuthError(502, "Twenty access token is not a JWT");
  }

  const encoded = parts[1] ?? "";
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes: number[] = [];

  for (let i = 0; i < padded.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(padded[i] ?? "=");
    const b = BASE64_ALPHABET.indexOf(padded[i + 1] ?? "=");
    const c = BASE64_ALPHABET.indexOf(padded[i + 2] ?? "=");
    const d = BASE64_ALPHABET.indexOf(padded[i + 3] ?? "=");
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new TwentyOAuthError(502, "Twenty access token has an invalid JWT payload");
    }
    bytes.push((a << 2) | (b >> 4));
    if (c !== 64) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d !== 64) bytes.push(((c & 3) << 6) | d);
  }

  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
  } catch {
    throw new TwentyOAuthError(502, "Twenty access token has an invalid JWT payload");
  }
}

/** 32 random bytes: 43 chars, inside the RFC 7636 43-128 bound. */
export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** 16 random bytes: the per-flow state nonce. */
export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** S256 challenge: base64url(SHA256(verifier)). Async — WebCrypto only. */
export async function codeChallengeForVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function buildAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface ClientAuth {
  clientId: string;
  clientSecret: string | null;
}

function clientAuthBody(auth: ClientAuth): Record<string, string> {
  // Public clients omit the secret entirely rather than sending an empty one,
  // so Twenty cannot be tempted into the confidential path.
  return auth.clientSecret
    ? { client_id: auth.clientId, client_secret: auth.clientSecret }
    : { client_id: auth.clientId };
}

/**
 * Server metadata discovery. Endpoint paths come from the document, never from
 * string constants, so a self-hosted instance with different paths still works.
 */
export async function discoverOAuth(baseUrl: string, fetchFn: FetchFn = fetch): Promise<OAuthEndpoints> {
  const response = await fetchFn(joinUrl(baseUrl, ".well-known/oauth-authorization-server"));
  if (!response.ok) {
    throw new TwentyOAuthError(response.status, (await response.text().catch(() => "")).slice(0, 300));
  }
  const doc = (await response.json()) as Record<string, unknown>;
  const pick = (name: string, required: boolean): string | null => {
    const value = doc[name];
    if (typeof value === "string" && value !== "") return new URL(value, baseUrl).toString();
    if (required) throw new TwentyOAuthError(502, `Twenty discovery document has no ${name}`);
    return null;
  };
  return {
    authorizationEndpoint: pick("authorization_endpoint", true) as string,
    tokenEndpoint: pick("token_endpoint", true) as string,
    registrationEndpoint: pick("registration_endpoint", false),
    introspectionEndpoint: pick("introspection_endpoint", false),
    revocationEndpoint: pick("revocation_endpoint", false),
  };
}

/**
 * RFC 7591 dynamic registration. Provided so a new deployment can mint its own
 * public client; the registered id is then set as TWENTY_OAUTH_CLIENT_ID.
 * Not wired to a route — registration is a one-off operator action.
 */
export async function registerClient(
  registrationEndpoint: string,
  input: { clientName: string; redirectUris: string[] },
  fetchFn: FetchFn = fetch,
): Promise<{ clientId: string }> {
  const response = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    throw new TwentyOAuthError(response.status, (await response.text().catch(() => "")).slice(0, 300));
  }
  const body = (await response.json()) as { client_id?: unknown; client_secret?: unknown };
  if (typeof body.client_id !== "string" || body.client_id === "") {
    throw new TwentyOAuthError(502, "Twenty registration returned no client_id");
  }
  // A secret is discarded rather than returned: a public client must not drift
  // back into sending one.
  return { clientId: body.client_id };
}

function toTokenSet(body: Record<string, unknown>): TokenSet {
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new TwentyOAuthError(502, "Twenty token endpoint returned no access_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

async function postForm(
  endpoint: string,
  params: Record<string, string>,
  fetchFn: FetchFn,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new TwentyOAuthError(response.status, (await response.text().catch(() => "")).slice(0, 300));
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Redeem an authorization code. The verifier never travels except here. */
export async function exchangeCode(
  tokenEndpoint: string,
  input: { code: string; redirectUri: string; verifier: string; auth: ClientAuth },
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  return toTokenSet(
    await postForm(
      tokenEndpoint,
      {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
        ...clientAuthBody(input.auth),
      },
      fetchFn,
    ),
  );
}

/** Rotate an expired access token. A null refresh token means re-login. */
export async function refreshAccessToken(
  tokenEndpoint: string,
  input: { refreshToken: string; auth: ClientAuth },
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  return toTokenSet(
    await postForm(
      tokenEndpoint,
      { grant_type: "refresh_token", refresh_token: input.refreshToken, ...clientAuthBody(input.auth) },
      fetchFn,
    ),
  );
}

/**
 * Ask Twenty whether a token is live. This is how a backend validates an
 * operator token without a JWKS: introspection is the documented mechanism and
 * `active: true` is the only answer that matters.
 */
export async function introspectToken(
  introspectionEndpoint: string,
  input: { token: string; auth: ClientAuth },
  fetchFn: FetchFn = fetch,
): Promise<Introspection> {
  const body = await postForm(introspectionEndpoint, { token: input.token, ...clientAuthBody(input.auth) }, fetchFn);
  return {
    active: body.active === true,
    username: typeof body.username === "string" ? body.username : null,
    sub: typeof body.sub === "string" ? body.sub : null,
    scope: typeof body.scope === "string" ? body.scope : null,
    expiresAt: typeof body.exp === "number" ? body.exp : null,
    claims: body,
  };
}

/** True when `expiresIn` seconds from `obtainedAtMs` have passed (60s skew). */
export function isTokenExpired(obtainedAtMs: number, expiresIn: number | null, nowMs = Date.now()): boolean {
  if (expiresIn === null) return false;
  return nowMs >= obtainedAtMs + expiresIn * 1000 - 60_000;
}