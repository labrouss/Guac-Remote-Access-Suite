/**
 * Requested directly, as part of an idle-session-timeout feature:
 * requireAuth.ts now refreshes a session's JWT on every valid request
 * (a sliding window), which on its own would mean a tab left open with
 * nothing but background polling happening (ShareNotifications.tsx
 * polls every 10s, for instance) never actually times out on idle
 * grounds — the poll itself is a perfectly valid, successful request as
 * far as the backend can tell. This module tracks *genuine* user
 * activity separately, so authFetchInterceptor.ts can tell the
 * difference between "the tab is open and polling" and "someone is
 * actually here" before deciding whether to accept a refreshed token.
 *
 * Listens in the CAPTURING phase specifically, not the default bubbling
 * phase — SessionViewport.tsx's own comment documents that
 * Guacamole.Keyboard attaches its own listener to `document` globally
 * (same target these listeners use), and Guacamole.Mouse attaches to
 * the session's own display element, an ancestor-descendant
 * relationship where a bubbling-phase stopPropagation() on the display
 * element would prevent the event from ever reaching a bubbling-phase
 * listener on `document`. A capturing-phase listener on `document` runs
 * during the capture pass, before the event ever reaches the display
 * element at all, so it's never at risk of being skipped by anything
 * downstream doing that — confirmed as the correct fix rather than
 * assumed, since a document-level listener that silently misses
 * activity during an actively-used remote session would defeat the
 * entire point of this module.
 */

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

// Module-level, not per-component state — this needs to be a single,
// shared timestamp regardless of how many components exist at any
// moment, and needs to keep updating even while no component tied to
// idle-timeout logic happens to be mounted.
let lastActivityAt = Date.now();

// Coarse on purpose: mousemove alone can fire dozens of times a second,
// and every one of those doesn't need its own Date.now() call and
// variable write. This still updates far more often than the minute-
// scale windows the caller cares about, so the coarseness costs nothing
// real.
const THROTTLE_MS = 2000;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;

function recordActivity() {
  lastActivityAt = Date.now();
}

function onActivityEvent() {
  if (throttleTimer) return;
  recordActivity();
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
  }, THROTTLE_MS);
}

let installed = false;

/** Idempotent — safe to call more than once (e.g. React Fast Refresh in dev); only attaches listeners the first time. */
export function installActivityTracker() {
  if (installed) return;
  installed = true;
  for (const eventName of ACTIVITY_EVENTS) {
    document.addEventListener(eventName, onActivityEvent, { capture: true, passive: true });
  }
}

/** Milliseconds since the last genuine (mouse/keyboard/touch) activity was observed. */
export function msSinceLastActivity(): number {
  return Date.now() - lastActivityAt;
}
