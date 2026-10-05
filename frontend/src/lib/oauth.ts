/**
 * Operator sign-in against Twenty (S256 PKCE). The verifier lives in
 * sessionStorage; the code is redeemed through /api/oauth/token so no secret
 * or Twenty CORS is involved; /api/oauth/session mints the Offer JWT that
 * every existing API call already expects. Same flow as open-twenty-dialer.
 */
import {
  buildAuthorizeUrl,
  codeChallengeForVerifier,
  generateCodeVerifier,
  generateState,
} from '@/lib/twenty-oauth';

const API_URL = import.meta.env.VITE_API_URL || '';
const PENDING_KEY = 'offer.oauth.pending';

interface PendingFlow {
  verifier: string;
  state: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Request failed: ${res.status}`);
  return json as T;
}

/** Start sign-in: stash the verifier, redirect to Twenty. */
export async function beginSignIn(): Promise<void> {
  const res = await fetch(`${API_URL}/api/oauth/config`);
  if (!res.ok) throw new Error('Twenty SSO is not configured on the backend');
  const config = (await res.json()) as {
    authorizationEndpoint: string;
    clientId: string;
    redirectUri: string;
    scope: string;
  };
  // Twenty returns the browser to redirectUri; running anywhere else lands on a dead address.
  if (window.location.origin !== new URL(config.redirectUri).origin) {
    throw new Error(
      `This page runs at ${window.location.origin}, but Twenty will send you back to ${config.redirectUri}. ` +
        'Open the app on that origin, or register this origin as a redirect URI and update TWENTY_OAUTH_REDIRECT_URI.',
    );
  }
  const verifier = generateCodeVerifier();
  const state = generateState();
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state } satisfies PendingFlow));
  window.location.assign(
    buildAuthorizeUrl({
      authorizationEndpoint: config.authorizationEndpoint,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scope: config.scope,
      state,
      challenge: await codeChallengeForVerifier(verifier),
    }),
  );
}

// StrictMode runs the callback effect twice in dev; reuse the one in-flight exchange.
const inFlight = new Map<string, Promise<void>>();

/** Finish sign-in on /callback: verify state, redeem code, store the Offer JWT. */
export function finishSignIn(search: string): Promise<void> {
  const params = new URLSearchParams(search);
  if (params.get('error')) {
    return Promise.reject(
      new Error(`Twenty refused authorization: ${params.get('error_description') ?? params.get('error')}`),
    );
  }
  const code = params.get('code') ?? '';
  const returnedState = params.get('state') ?? '';
  if (!code) return Promise.reject(new Error('Twenty returned no authorization code'));

  const existing = inFlight.get(code);
  if (existing) return existing;

  const raw = sessionStorage.getItem(PENDING_KEY);
  const pending = (raw ? JSON.parse(raw) : null) as PendingFlow | null;
  if (!pending || pending.state !== returnedState) {
    return Promise.reject(new Error('OAuth state mismatch. Start sign-in again.'));
  }

  const promise = (async () => {
    try {
      const { tokens } = await post<{ tokens: { accessToken: string } }>('/api/oauth/token', {
        code,
        verifier: pending.verifier,
      });
      const { token } = await post<{ token: string }>('/api/oauth/session', {
        accessToken: tokens.accessToken,
      });
      sessionStorage.removeItem(PENDING_KEY);
      localStorage.setItem('offer-builder-token', token);
    } catch (error) {
      inFlight.delete(code);
      throw error;
    }
  })();
  inFlight.set(code, promise);
  return promise;
}
