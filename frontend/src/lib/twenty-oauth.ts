/**
 * Browser subset of backend/src/lib/twenty/oauth.ts (PKCE + authorize URL),
 * hand-mirrored because Offer has no shared package. Change both together.
 */

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
