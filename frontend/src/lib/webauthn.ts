import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';

export { browserSupportsWebAuthn };

/**
 * Requested directly, live: someone hit "This browser doesn't support
 * passkeys" on a real, modern browser and (correctly) didn't believe it.
 * `browserSupportsWebAuthn()` checks for `window.PublicKeyCredential`,
 * which the WebAuthn spec itself only ever exposes in a secure context
 * (HTTPS, or `localhost` specifically) — this app's own default
 * docker-compose.prod.yml serves plain HTTP by design (see that file's
 * own comment: "put a TLS-terminating reverse proxy... in front of this
 * in production"), so anyone reaching it over plain HTTP by its real
 * hostname or IP, not literally `localhost`, would see the API itself
 * genuinely absent regardless of how modern their actual browser is.
 * `browserSupportsWebAuthn()` alone can't distinguish "this browser
 * doesn't have passkeys" from "this connection isn't secure enough for
 * the browser to offer them here" — both look identical from its own,
 * single boolean return — so a caller checks this first and shows the
 * right one of the two real explanations, not always the more alarming,
 * less accurate one.
 */
export function isSecureContext(): boolean {
  return window.isSecureContext;
}

/**
 * A stable code for client-generated failures (LoginPage.tsx and the
 * passkey settings page translate these themselves) vs. a `serverMessage`
 * carrying the backend's own text verbatim, untranslated — the same
 * "server-provided reason stays in English" precedent LoginPage.tsx's
 * own existing comment on its password-login error handling already
 * established, kept consistent here rather than introduced fresh.
 */
export type PasskeyErrorCode = 'cancelled' | 'device_error' | 'network_error';
export class PasskeyError extends Error {
  code?: PasskeyErrorCode;
  serverMessage?: string;
  constructor(opts: { code?: PasskeyErrorCode; serverMessage?: string }) {
    super(opts.serverMessage ?? opts.code ?? 'passkey_error');
    this.code = opts.code;
    this.serverMessage = opts.serverMessage;
  }
}

/**
 * Registers a new passkey for the currently signed-in user.
 */
export async function registerPasskey(apiBase: string, authToken: string, name: string): Promise<void> {
  const optionsRes = await fetch(`${apiBase}/api/me/passkeys/register-options`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }
  });
  if (!optionsRes.ok) throw new PasskeyError({ code: 'network_error' });
  const { options, registrationToken } = await optionsRes.json();

  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err: any) {
    // NotAllowedError is WebAuthn's own standard cancellation error —
    // the person dismissed their own browser/OS prompt, not a real
    // failure of anything this app did.
    throw new PasskeyError({ code: err?.name === 'NotAllowedError' ? 'cancelled' : 'device_error' });
  }

  const verifyRes = await fetch(`${apiBase}/api/me/passkeys/register-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ registrationToken, response, name })
  });
  if (!verifyRes.ok) {
    const body = await verifyRes.json().catch(() => ({}));
    throw new PasskeyError({ serverMessage: body.message, code: 'network_error' });
  }
}

/**
 * Signs in with a passkey — deliberately usernameless: the browser/OS
 * itself surfaces whichever passkeys it holds for this origin, nobody
 * types a username first. Returns the same shape /api/auth/login and
 * /api/auth/login/totp already return on success, so LoginPage.tsx's
 * own afterLoginSuccess handles all three identically.
 */
export async function loginWithPasskey(): Promise<{ sessionToken: string; mustChangePassword: boolean }> {
  const optionsRes = await fetch('/api/auth/passkey/options', { method: 'POST' });
  if (!optionsRes.ok) throw new PasskeyError({ code: 'network_error' });
  const { options, authToken } = await optionsRes.json();

  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err: any) {
    throw new PasskeyError({ code: err?.name === 'NotAllowedError' ? 'cancelled' : 'device_error' });
  }

  const verifyRes = await fetch('/api/auth/passkey/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authToken, response })
  });
  const data = await verifyRes.json();
  if (!verifyRes.ok) throw new PasskeyError({ serverMessage: data.message, code: 'network_error' });
  return data;
}
