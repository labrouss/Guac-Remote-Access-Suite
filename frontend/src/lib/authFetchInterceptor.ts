import { msSinceLastActivity } from './activityTracker';

/**
 * Requested directly, and a real crash traced back to exactly this root
 * cause: when a session token expires or becomes invalid, every
 * existing /api/ call throughout the app was on its own to notice and
 * handle a 401 correctly — most didn't. ConnectionPanel.tsx's own
 * connections-list fetch is a concrete example, not a hypothetical one:
 * it never checked res.ok, so a 401's error-object response body got
 * set directly as its `lists` state (an object, not an array), and the
 * very next render's `lists.find(...)` — a synchronous, top-level call,
 * not inside the async callback where a .catch() could have caught it
 * — threw and crashed the entire React tree with no error boundary to
 * catch it. That's the exact "empty page" reported, confirmed by
 * matching the reported stack trace's React-internal reconciler frames
 * against where in the source this specific call actually lives.
 *
 * Rather than track down and individually patch every current (and
 * future) /api/ call throughout the app that could hit this same class
 * of bug, this wraps the global fetch function itself, once, at
 * startup — every existing and future fetch() call automatically
 * benefits without needing to change at all. Purely an observer: it
 * always returns the real response untouched, so any code doing its own
 * res.ok checking keeps working exactly as before. It only adds a side
 * effect for the one specific case that actually means "your session is
 * no longer valid": a 401 from a genuinely protected /api/ endpoint.
 *
 * Deliberately excludes /api/auth/ and /api/setup/ — both are
 * pre-authentication flows (login itself, and the one-time setup
 * wizard's own separate, cookie-based auth) where a 401 means something
 * else entirely ("wrong credentials," not "your session expired") and
 * redirecting to /login in response would be nonsensical — for a login
 * attempt specifically, the person is already there, and it would mask
 * the real error message the login form is trying to show them.
 *
 * IDLE-SESSION TIMEOUT: requireAuth.ts refreshes a session's JWT
 * (sliding window) on every valid request and returns it via the
 * X-Refreshed-Session-Token response header. That alone would mean a
 * tab with nothing but background polling happening never times out —
 * the poll is a perfectly valid request as far as the backend can tell
 * — so the refreshed token is only actually stored when
 * activityTracker.ts reports genuine (mouse/keyboard/touch) activity
 * within the last ACTIVITY_RECENCY_MS; otherwise it's discarded, and
 * the still-stored, already-issued token keeps ticking down to its own
 * real expiry regardless of how many background requests keep
 * succeeding in the meantime. A separate periodic check
 * (startIdleExpiryWatcher) reads that same stored token's own `exp`
 * claim directly and redirects proactively once it's passed, rather
 * than waiting for whatever background call happens to hit a 401 next
 * — which, with polling intervals in the range of many seconds, could
 * otherwise leave someone looking at a dead session for a while before
 * the app visibly reacts.
 */

const ACTIVITY_RECENCY_MS = 90_000;
const IDLE_EXPIRY_CHECK_INTERVAL_MS = 10_000;
const SESSION_TOKEN_KEY = 'guac.sessionToken';
const EXPIRED_REASON_KEY = 'guac.sessionExpiredReason';

function decodeJwtExp(token: string): number | null {
  try {
    const payloadSegment = token.split('.')[1];
    // atob expects standard base64 (+ / =), JWTs use base64url (- _, no
    // padding) — translated here rather than assuming they're
    // interchangeable, since a JWT's own payload segment routinely
    // contains - or _ once base64-encoded and would otherwise decode to
    // silently wrong bytes rather than throwing. Padding restored too,
    // not just the character substitution: confirmed directly against
    // a real atob() (not Node's much more lenient Buffer.from, which
    // this bug's first draft was accidentally verified against and
    // passed) that an unpadded base64url segment — the normal case,
    // since JWTs never include padding — throws "contains invalid
    // characters" outright rather than merely decoding wrong, unless
    // padded back out to a multiple of 4 first.
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function redirectToExpiredLogin(reason: 'inactivity' | 'server') {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  sessionStorage.setItem(EXPIRED_REASON_KEY, reason);
  window.location.href = '/login';
}

/**
 * Runs independently of any fetch happening at all — a tab that's been
 * left open with no background polling configured (unlikely in this
 * app today, but this shouldn't depend on that) would otherwise only
 * discover its own session had expired the next time a person tried to
 * use it, well after the fact. Idempotent, same reasoning as
 * activityTracker.ts's own installActivityTracker.
 */
let idleWatcherStarted = false;
export function startIdleExpiryWatcher() {
  if (idleWatcherStarted) return;
  idleWatcherStarted = true;
  setInterval(() => {
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) return;
    const exp = decodeJwtExp(token);
    if (exp !== null && Date.now() / 1000 > exp) {
      redirectToExpiredLogin('inactivity');
    }
  }, IDLE_EXPIRY_CHECK_INTERVAL_MS);
}

export function installAuthFetchInterceptor() {
  const originalFetch = window.fetch.bind(window);
  // Guards against multiple in-flight requests all hitting 401 around
  // the same moment (the realistic case — a token expiring mid-session
  // means several already-in-flight calls likely fail together, not
  // just one) each independently trying to clear storage and redirect.
  let redirecting = false;

  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await originalFetch(...args);

    const input = args[0];
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const path = new URL(rawUrl, window.location.origin).pathname;
    const isProtectedApiCall = path.startsWith('/api/') && !path.startsWith('/api/auth/') && !path.startsWith('/api/setup/');

    if (isProtectedApiCall && response.ok) {
      const refreshed = response.headers.get('X-Refreshed-Session-Token');
      if (refreshed && msSinceLastActivity() < ACTIVITY_RECENCY_MS) {
        sessionStorage.setItem(SESSION_TOKEN_KEY, refreshed);
      }
      // No `else`: a refreshed token arriving while the user's been idle
      // too long is deliberately just discarded, not stored — the
      // already-stored, earlier-issued token keeps counting down to its
      // own real expiry on schedule, which startIdleExpiryWatcher above
      // (or, failing that, this same interceptor's own 401 handling
      // below) will eventually act on.
    }

    if (response.status === 401 && !redirecting && isProtectedApiCall) {
      redirecting = true;
      redirectToExpiredLogin('server');
    }

    return response;
  };
}
