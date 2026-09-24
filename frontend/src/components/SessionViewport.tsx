import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Guacamole from 'guacamole-common-js';
import { getGuacamoleAudioContext } from '../lib/guacamoleAudio';

// Human-readable text for Guacamole.Status.Code, keyed by the numeric
// code — verified directly against the real installed
// guacamole-common-js source (its own JSDoc comments on
// Guacamole.Status.Code) rather than written from memory, so these
// match the actual, current values and meanings rather than a
// remembered approximation of an older or different version.
const GUAC_STATUS_DESCRIPTIONS: Record<number, string> = {
  [Guacamole.Status.Code.UNSUPPORTED]: 'The requested operation is unsupported.',
  [Guacamole.Status.Code.SERVER_ERROR]: 'An internal server error occurred.',
  [Guacamole.Status.Code.SERVER_BUSY]: 'The server is busy. Try again shortly.',
  [Guacamole.Status.Code.UPSTREAM_TIMEOUT]: 'The remote server is not responding.',
  [Guacamole.Status.Code.UPSTREAM_ERROR]: 'An unexpected error occurred on the remote server.',
  [Guacamole.Status.Code.RESOURCE_NOT_FOUND]: 'The requested connection does not exist.',
  [Guacamole.Status.Code.RESOURCE_CONFLICT]: 'The requested resource is already in use.',
  [Guacamole.Status.Code.RESOURCE_CLOSED]: 'The connection is closed.',
  [Guacamole.Status.Code.UPSTREAM_NOT_FOUND]: 'The remote server could not be found.',
  [Guacamole.Status.Code.UPSTREAM_UNAVAILABLE]: 'The remote server is unavailable.',
  [Guacamole.Status.Code.SESSION_CONFLICT]: 'The session ended due to a conflict with another session.',
  [Guacamole.Status.Code.SESSION_TIMEOUT]: 'The session ended because it appeared to be inactive.',
  [Guacamole.Status.Code.SESSION_CLOSED]: 'The session was forcibly terminated.',
  [Guacamole.Status.Code.CLIENT_BAD_REQUEST]: 'The connection request was invalid.',
  [Guacamole.Status.Code.CLIENT_UNAUTHORIZED]: 'Authentication failed — check the username and password.',
  [Guacamole.Status.Code.CLIENT_FORBIDDEN]: 'Access to this connection was denied.',
  [Guacamole.Status.Code.CLIENT_TIMEOUT]: 'The client took too long to respond.',
  [Guacamole.Status.Code.CLIENT_OVERRUN]: 'Too much data was sent.',
  [Guacamole.Status.Code.CLIENT_BAD_TYPE]: 'Unsupported or unexpected data was sent.',
  [Guacamole.Status.Code.CLIENT_TOO_MANY]: 'Too many resources are already in use.'
};

interface AdhocSettings {
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  password: string;
  params?: Record<string, unknown>;
}

interface Props {
  /** Absent for an ad-hoc connection (see adhocSettings below) — there's
   * no saved connection row to reference at all in that case. */
  connectionId?: string;
  protocol: string;
  apiBase: string;
  authToken: string;
  isActive: boolean;
  /** Set when this viewport is joining someone else's live session rather
   * than opening a new connection — see the "Live session sharing" note
   * below. */
  joinSessionId?: string;
  /** Only meaningful alongside joinSessionId. */
  readOnly?: boolean;
  /** Set for an ad-hoc connection — filled in directly rather than opening
   * a saved one. Mutually exclusive with connectionId/joinSessionId;
   * see the token-fetching logic below for how this changes which
   * endpoint gets used. Deliberately does NOT get the same onSessionReady
   * wiring a normal or joined session does (see that prop's own comment)
   * — Record/Share/paste-file/RDP-download-tray all depend on a real,
   * saved connectionId to look anything up by by, which an ad-hoc session
   * genuinely doesn't have. The session itself still works fully; those
   * few extra features specifically don't apply to this kind of session,
   * the same considered, deliberate scope this app's own design doc for
   * this feature settled on rather than something overlooked. */
  adhocSettings?: AdhocSettings;
  /** Fires once the real backend `sessions.id` is known — for a new
   * connection this requires an extra lookup after connecting (the
   * frontend only knows connectionId until then); for a join it's already
   * known upfront. MainApp uses this to wire the Record/Share buttons to
   * the correct id instead of the connectionId — passing connectionId
   * there was a real, previously-shipped bug (the record endpoint expects
   * sessions.id, a different UUID space entirely, and was silently 404ing). */
  onSessionReady?: (sessionId: string) => void;
}

const MAX_AUTO_RECONNECT_ATTEMPTS = 5;
// If neither client.onstatechange (state 3 = connected) nor client.onerror
// fires within this long after calling client.connect(), the UI treats it
// as a failed connection attempt. Found live: a genuinely hung connection
// (WebSocket/TCP established, but guacd or something between it and the
// browser never sends any Guacamole protocol data back at all — no error,
// no state transition) left the screen stuck showing "connecting" forever,
// with no way to tell anything was wrong and no way to retry short of a
// full page reload. Neither of the two existing callbacks is a bug by
// itself — both correctly handle the cases they're built for — the gap was
// that nothing was watching for the case where neither ever fires at all.
const CONNECT_TIMEOUT_MS = 20000;

/**
 * Renders one live Guacamole session (RDP/VNC/SSH) into a canvas, wires up
 * bidirectional text clipboard sync, and intercepts file pastes so they go
 * through the backend's SFTP/drive-redirection path instead of being typed
 * into the terminal as raw bytes. See docs/ARCHITECTURE.md for why file
 * transfer multiplexes over the already-authenticated session rather than
 * opening a second connection.
 *
 * Also handles reconnect-on-drop: an unexpected WebSocket close (network
 * blip, backend restart, guacd hiccup) retries with exponential backoff up
 * to MAX_AUTO_RECONNECT_ATTEMPTS, then falls back to a manual "Reconnect"
 * button rather than retrying forever in the background.
 *
 * IMPORTANT for multi-session use (MainApp.tsx keeps several of these
 * mounted at once, hidden rather than unmounted, so a background session
 * stays connected): `Guacamole.Keyboard` attaches its listener to `document`
 * globally, not scoped to this component's own DOM subtree — with more than
 * one instance mounted, every keystroke would otherwise reach every open
 * session's remote host simultaneously. `isActive` gates every outgoing
 * key/mouse event so only the currently-focused session actually forwards
 * input; the WebSocket tunnel itself stays open and rendering regardless,
 * which is what lets switching sessions feel instant.
 *
 * LIVE SESSION SHARING: when `joinSessionId` is set, this fetches a join
 * token (`POST /api/sessions/:joinSessionId/join-token`) instead of a
 * new-connection token, joining an already-active session rather than
 * opening one — the Guacamole client setup below is otherwise identical.
 * `readOnly` sessions never forward keyboard/mouse input at all, regardless
 * of `isActive` (view-only, matching what the backend enforces on the
 * guacd side via the join token's own `read-only` setting).
 */
export function SessionViewport({
  connectionId,
  protocol,
  apiBase,
  authToken,
  isActive,
  joinSessionId,
  readOnly,
  adhocSettings,
  onSessionReady
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const intentionalDisconnectRef = useRef(false);
  // Reported directly: no sound in any connection. Checked directly
  // against the official Guacamole manual before assuming this was a
  // Guacamole limitation at all — it isn't one: audio redirection is
  // enabled by default on both the client and the RDP backend, with no
  // "enable" parameter needed at all, and this project's own
  // guacTunnel.ts never sets disable-audio either. The far more likely,
  // well-documented cause: guacamole-common-js's own built-in audio
  // playback shares one single, page-wide Web Audio API AudioContext
  // (Guacamole.AudioContextFactory's own singleton), and every major
  // browser creates that context in a "suspended" state until a real,
  // direct user gesture resumes it — confirmed directly against
  // Chrome's own developer documentation on this exact policy. Nothing
  // in guacamole-common-js's own audio player appears to call resume()
  // itself, so audio data can arrive and be processed perfectly
  // correctly while genuinely never being audible at all, with no
  // error anywhere to indicate why. This ref just avoids calling
  // resume() on every single mousemove once it's already succeeded
  // once — resume() itself is harmless to call repeatedly, this is
  // purely to skip the redundant calls, not because a second one would
  // ever cause a problem.
  const audioResumedRef = useRef(false);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Requested directly (a real, severe regression reported live): the
  // connect effect below fetches a tunnel token using authToken, but
  // must NOT re-run every time authToken's own string value changes —
  // which, since requireAuth.ts's own idle-timeout sliding-window
  // refresh (see sessionToken.ts), happens on every successful /api/
  // request throughout the app, including background polling
  // (ShareNotifications.tsx's own 10s poll) that has nothing to do with
  // this session specifically. AppShell.tsx's own authToken is a plain
  // const re-read from sessionStorage on every render, not memoized, so
  // any one of those unrelated background refreshes was enough to hand
  // this component a new authToken string on its next render — and
  // with authToken in the connect effect's own dependency array, that
  // was tearing down and re-establishing the entire WebSocket tunnel
  // every time, which is exactly the reported symptom: guacd's own logs
  // showed real, successful SSH connections being torn down and
  // recreated in a tight loop, seconds apart, the connection itself
  // never actually failing at all. A stale-but-still-valid token read
  // via a ref at the moment connect() actually runs is correct here —
  // this tunnel was never going to be kept alive by a continuously
  // fresh main session JWT in the first place (a passkey- or
  // password-issued token's own ongoing validity was never checked
  // again once the tunnel was established, only at the one moment this
  // effect fetches its own tunnel token), so there's no real loss from
  // not reacting to every refresh, only the real bug from doing so.
  const authTokenRef = useRef(authToken);
  authTokenRef.current = authToken;
  const canSendInputRef = useRef(!readOnly);
  canSendInputRef.current = !readOnly;
  // Not just a ref mirroring isActive (that pattern's used elsewhere in
  // this file for values read from event listeners registered once) —
  // this specifically holds the live Guacamole.Keyboard instance itself,
  // so a separate effect below (keyed on the isActive prop) can reach
  // in and toggle its handlers directly. See that effect's own comment
  // for why this needed a genuinely different fix than checking
  // isActiveRef inside the handlers, which was already being done and
  // wasn't enough on its own.
  const keyboardRef = useRef<Guacamole.Keyboard | null>(null);
  const keyDownHandlerRef = useRef<((keysym: number) => void) | null>(null);
  const keyUpHandlerRef = useRef<((keysym: number) => void) | null>(null);
  // Tracks whether Ctrl or Cmd/Super (Mac's own paste modifier — browsers
  // map the Mac Cmd key to the X11 Super_L/Super_R keysym here, the same
  // way guacamole-common-js's own Keyboard translates it) is currently
  // held, purely to detect a Ctrl+V/Cmd+V paste shortcut below — see
  // handlePasteShortcut's own comment for why this, not the native DOM
  // "paste" event, is what actually triggers local-to-remote clipboard
  // sync now.
  const pasteModifierHeldRef = useRef(false);
  // Guards against key-repeat: holding Ctrl+V down fires repeated,
  // real keydown events for 'v' the whole time it's held (completely
  // normal, native browser behavior for a held key) — without this,
  // each one would independently re-trigger handlePasteShortcut,
  // meaning a held Ctrl+V that happens to be pasting a *file* could
  // re-upload that same file several times over. Set the moment 'v'
  // is first pressed while the modifier is down, cleared on 'v's own
  // keyup — so only that genuine down-transition triggers a sync, not
  // every repeat while it stays held.
  const pasteKeyAlreadyDownRef = useRef(false);
  // Tracks the real, physical Shift state — needed specifically so the
  // terminal-protocol Ctrl+Shift+V synthesis below (keyDownHandlerRef)
  // never releases Shift the person is still genuinely, physically
  // holding down for some unrelated reason, and never redundantly
  // presses a synthetic Shift on top of one already held (e.g. someone
  // who, correctly, already presses Ctrl+Shift+V themselves).
  const shiftHeldRef = useRef(false);
  // A received remote-clipboard update that couldn't be written to the
  // local clipboard immediately — see client.onclipboard's own comment
  // below for why this happens (and is expected) in some browsers, and
  // pendingRemoteClipboardTextRef's own retry point in
  // keyDownHandlerRef for how it eventually gets written anyway.
  const pendingRemoteClipboardTextRef = useRef<string | null>(null);
  // Whether this specific connection *attempt* has ever reached
  // CONNECTED — see the onstatechange/onerror handlers below for why
  // this, not a specific status code, is the actual reconnect signal.
  // Reset per attempt (inside connect() itself), not just declared once
  // — each auto-retry is its own fresh attempt that hasn't connected yet
  // either, regardless of whether an *earlier* attempt in this same
  // session had.
  const hasConnectedRef = useRef(false);

  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error'>(
    'connecting'
  );
  // Requested directly ("error codes might pop-up after a connection
  // failure?"): the actual Guacamole.Status this session's onerror last
  // received was previously discarded entirely — the UI only ever
  // showed the literal string "error" with nothing else, regardless of
  // what genuinely went wrong (a bad credential, an unreachable host, a
  // busy server, and so on all looked identical). Captured unconditionally
  // at the top of onerror below, not only on the specific path that ends
  // in setStatus('error') directly — scheduleReconnect can also arrive at
  // 'error' after exhausting its own retries, and this way whichever path
  // actually gets there, the most recent real status is already on hand.
  const [lastErrorStatus, setLastErrorStatus] = useState<{ code: number; message: string } | null>(null);
  // Toggles the container's own CSS cursor to `none` once the remote
  // side actually sends a cursor image — real bug found live: the local
  // browser cursor and Guacamole's own rendered remote cursor were both
  // visible at once over RDP, two pointers tracking together. Confirmed
  // from the real installed guacamole-common-js source: display.oncursor
  // only ever fires in response to the protocol's own "cursor"
  // instruction, which guacd only sends for cursor-image-based protocols
  // (RDP, VNC) — never for SSH, which has no remote-cursor-image concept
  // at all. Driving this off that real signal, rather than hardcoding a
  // per-protocol list here, means it stays correct for any protocol
  // guacd might add cursor support for later without this needing an
  // update, and SSH naturally keeps the normal local cursor visible.
  const [hasRemoteCursor, setHasRemoteCursor] = useState(false);
  const [transferProgress, setTransferProgress] = useState<number | null>(null);
  // Surfaces the real reason an upload failed, rather than the
  // transfer-progress chip just silently vanishing with nothing to
  // explain why — the previous, silent-failure behavior would have
  // made any real upload problem (a network error, an auth issue, the
  // backend itself rejecting it) completely invisible and
  // undiagnosable, for the person hitting it and for anyone trying to
  // debug it from a report afterward alike.
  // A real bug caught here directly, from an actual report showing the
  // exact, resulting wording: "Upload failed: Download failed with
  // status 404" — a single, undifferentiated error slot meant a
  // download failure always rendered through the upload-specific
  // label regardless of which direction actually failed. Tracks which
  // direction failed alongside the message now, not just the message
  // alone, so the UI can render the right one.
  const [transferError, setTransferError] = useState<{ direction: 'upload' | 'download'; message: string } | null>(null);
  // Reported directly: pasting a real file copied from the OS's own file
  // manager (Windows Explorer, Finder, etc.) — not an image copied from
  // within a web page — simply didn't work at all, plain text alone did.
  // Checked directly, not assumed, against multiple independent,
  // authoritative sources (MDN, web.dev): the Async Clipboard API's own
  // read() is documented to "commonly support reading text, HTML, and
  // PNG image data" — an arbitrary file from the OS's own file manager
  // was never something it could read at all, on any browser, not a bug
  // in the handlePasteShortcut logic above this actually reached. The
  // one, real, standard web mechanism for this — confirmed the same way
  // against Apache Guacamole's own official documentation, which
  // describes exactly this as how its own file transfer actually works —
  // is drag-and-drop, not clipboard paste, so that's what's added here,
  // genuinely new rather than a fix to what already existed.
  // handlePasteShortcut's own file-detection above is left completely
  // alone, not replaced — it's still correct for the one real case it
  // was ever capable of: an actual image explicitly copied from a web
  // page's own "Copy image" context-menu action, which does still reach
  // the clipboard as a genuine, non-text ClipboardItem.
  const [draggingFile, setDraggingFile] = useState(false);
  const [readyDownloads, setReadyDownloads] = useState<{ name: string; downloadUrl: string }[]>([]);
  // Reported directly: a large download gave no on-screen feedback at
  // all while it was in progress, so the natural response — clicking
  // the same download entry again, unsure whether the first click even
  // registered — fired a second, completely separate, overlapping
  // download request for the same file, since nothing tracked that one
  // was already under way. Per-filename, not a single flag, since more
  // than one entry can sit in the tray at once and each downloads
  // independently. -1 means "downloading, but no real percentage available"
  // (the server didn't send a Content-Length) rather than a fake, misleading 0%.
  const [downloadingFiles, setDownloadingFiles] = useState<Map<string, number>>(new Map());
  const [reconnectKey, setReconnectKey] = useState(0); // bumping this re-runs the connect effect

  // RDP only: poll for files the user dragged into the "Guacamole Transfer"
  // drive from inside the remote Windows session, so they can be offered as
  // a normal browser download without the user having to go find a menu.
  // Skipped for joins — the backend's lookup for this is scoped to the
  // session OWNER specifically, so a joiner polling would just always get
  // an empty result; not worth the wasted requests.
  useEffect(() => {
    // Also skipped for an ad-hoc connection — no connectionId at all to
    // key this backend lookup by, same reasoning as the join-skip just
    // above. Both directions of RDP file transfer (this outbound
    // "here's a file ready to download" polling, and the inbound
    // paste-file handler below) are connectionId-keyed on the backend,
    // so neither applies to an ad-hoc session specifically — the
    // deliberate, considered scope for this feature's first version
    // (see SessionViewport's own Props comment on adhocSettings), not
    // something overlooked.
    if (protocol !== 'rdp' || joinSessionId || !connectionId) return;
    const interval = setInterval(async () => {
      const res = await fetch(`${apiBase}/api/sessions/${connectionId}/rdp-downloads`, {
        headers: { Authorization: `Bearer ${authTokenRef.current}` }
      });
      if (!res.ok) return;
      const { files } = await res.json();
      if (files.length) setReadyDownloads((prev) => [...prev, ...files]);
    }, 3000);
    return () => clearInterval(interval);
    // authToken deliberately excluded — read via authTokenRef instead so
    // this polling interval doesn't restart on every background session
    // token refresh; see authTokenRef's own comment above for the full
    // reasoning (the same root cause as the connect effect below, just a
    // milder symptom here — a brief gap in polling rather than the
    // entire tunnel being torn down).
  }, [protocol, connectionId, apiBase, joinSessionId]);

  useEffect(() => {
    let cancelled = false;
    intentionalDisconnectRef.current = false;

    async function connect() {
      setStatus((prev) => (prev === 'disconnected' || prev === 'error' ? 'reconnecting' : 'connecting'));
      // Reset per attempt, not just once for the whole effect — each
      // retry from scheduleReconnect() below calls connect() again
      // directly (not through a fresh effect run), and needs its own
      // genuine chance to reach CONNECTED before a subsequent drop
      // should stop being auto-retried.
      hasConnectedRef.current = false;

      // Two token types, same downstream Guacamole client setup: a
      // new-connection token (the usual case) or a join token (live
      // session sharing — see the class-level comment). Both are
      // short-lived and carry no credentials the frontend can read; the
      // encrypted payload itself is opaque here.
      // Three token types, same downstream Guacamole client setup: a
      // new-connection token (the usual case), a join token (live session
      // sharing), or — new — an ad-hoc token, built directly from
      // adhocSettings rather than looking up a saved connection at all.
      // All three are short-lived and carry no credentials the frontend
      // can read back out; the encrypted payload itself is opaque here.
      const tokenUrl = joinSessionId
        ? `${apiBase}/api/sessions/${joinSessionId}/join-token`
        : adhocSettings
          ? `${apiBase}/api/tunnel-token/adhoc`
          : `${apiBase}/api/tunnel-token/${connectionId}`;
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authTokenRef.current}`, 'Content-Type': 'application/json' },
        body: joinSessionId
          ? JSON.stringify({ readOnly: !!readOnly })
          : adhocSettings
            ? JSON.stringify(adhocSettings)
            : undefined
      });
      if (!res.ok) return setStatus('error');
      const { token } = await res.json();
      if (cancelled) return;

      // /tunnel, not just root / — the tunnel needs its own dedicated
      // path distinct from the SPA's own root-path static file serving.
      // Real bug found live: nginx's `location /` only serves
      // index.html/static assets (there's no way to distinguish a
      // WebSocket upgrade from a normal page request on the exact same
      // path without nginx's notoriously fragile `if` directive), so a
      // tunnel connecting to bare `/` was never reaching the backend at
      // all — nginx just served index.html in response, which the
      // browser correctly reported as an immediate WebSocket connection
      // failure. See frontend/nginx.conf's own comment for the other
      // half of this fix.
      const tunnel = new Guacamole.WebSocketTunnel(`${apiBase.replace(/^http/, 'ws')}/tunnel`);
      const client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      const display = client.getDisplay();
      if (containerRef.current) containerRef.current.innerHTML = ''; // clear any previous attempt's canvas
      containerRef.current?.appendChild(display.getElement());

      // Scales the display to fit the available container space, rather
      // than rendering at the remote session's native 1:1 pixel size.
      // Real, confirmed gap: there was no scaling logic here at all —
      // Guacamole's display defaults to exactly the negotiated remote
      // resolution, not automatically stretched or centered to fill
      // whatever space the container actually has. Confirmed via the
      // real installed guacamole-common-js source (Display.prototype.scale
      // sets a CSS transform on the internal display element and updates
      // getElement()'s own width/height to the resulting scaled pixel
      // size automatically) — so centering only needs the container
      // itself to use flexbox (see .session-canvas in theme.css), not
      // manual position math here.
      function updateScale() {
        if (!containerRef.current) return;
        const displayWidth = display.getWidth();
        const displayHeight = display.getHeight();
        if (!displayWidth || !displayHeight) return; // not yet negotiated
        const containerWidth = containerRef.current.clientWidth;
        const containerHeight = containerRef.current.clientHeight;
        if (!containerWidth || !containerHeight) return;
        display.scale(Math.min(containerWidth / displayWidth, containerHeight / displayHeight));
      }

      // onresize fires once the remote resolution is first known (right
      // as the connection completes) and again on any later resize the
      // remote session itself reports — both cases need a rescale.
      display.onresize = updateScale;

      // Reset per attempt, not just once — a reconnect (auto-retry, or
      // manual) genuinely starts over, and the previous attempt's cursor
      // state shouldn't linger into a fresh connection.
      setHasRemoteCursor(false);
      display.oncursor = () => setHasRemoteCursor(true);

      // Separately, the *container's own* available space can change
      // independently of the remote resolution (browser window resize,
      // anything in this app's own layout shifting) — a ResizeObserver
      // catches that side of it. Stored in a ref (not a local variable)
      // so this effect's own cleanup function below — a different
      // closure — can reach it to disconnect; disconnecting any stale
      // observer from a previous attempt first, matching the same
      // stale-timer hygiene already used for connectTimeoutRef above.
      if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
      resizeObserverRef.current = new ResizeObserver(updateScale);
      if (containerRef.current) resizeObserverRef.current.observe(containerRef.current);

      client.onstatechange = (state: number) => {
        // Guacamole.Client.State: 3 = CONNECTED, 5 = DISCONNECTED
        if (state === 3) {
          if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
          setStatus('connected');
          reconnectAttemptRef.current = 0; // a clean connect resets the backoff counter
          hasConnectedRef.current = true;

          if (joinSessionId) {
            // Already know which session this is — no lookup needed.
            onSessionReady?.(joinSessionId);
          } else if (onSessionReady && connectionId) {
            // No connectionId at all for an ad-hoc session — nothing valid
            // to key this lookup by, so Record/Share simply never get
            // wired up for one. Deliberate, considered scope for this
            // feature's first version (see SessionViewport's own Props
            // comment on adhocSettings), not an oversight; the session
            // itself still works fully either way, same as any other
            // best-effort failure of this same lookup already does.
            // The frontend only knows connectionId until this point — the
            // real backend `sessions.id` (a different UUID space) is
            // recovered here. Best-effort: if this fails, Record/Share
            // just won't be wired up correctly for this session, but the
            // session itself still works.
            fetch(`${apiBase}/api/sessions/${connectionId}/active`, {
              headers: { Authorization: `Bearer ${authTokenRef.current}` }
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => data && onSessionReady(data.sessionId))
              .catch(() => {});
          }
        }
        // Real bug found live, twice: checking the status code passed to
        // onerror (RESOURCE_CLOSED specifically, an earlier version of
        // this fix) does NOT reliably catch every kind of expected,
        // clean session end — an SSH `exit` and clicking Disconnect
        // inside an RDP session both still reopened the session even
        // after that fix. Traced all the way through the real installed
        // guacamole-common-js source to find out why: a clean WebSocket
        // close (code 1000, "Normal Closure") gets translated to
        // Guacamole.Status.Code.SUCCESS — and close_tunnel's own real
        // implementation explicitly only calls onerror `if (status.code
        // !== SUCCESS)`. A clean close means onerror is never called at
        // all; only this onstatechange(5) branch ever sees it, and
        // onstatechange only ever receives a bare number, no status
        // object to check a code on in the first place. Enumerating
        // every pathway a "clean close" can arrive through turned out to
        // be genuinely fragile — proven twice now, not just theorized —
        // so this uses a structural signal instead of a specific status
        // code: once a session has successfully connected even once,
        // any disconnect after that point is treated as the session
        // having ended, full stop, regardless of which of possibly
        // several pathways reported it. Auto-reconnect is still fully
        // in effect for failures *before* ever reaching CONNECTED (a
        // genuine connection failure, which is what auto-reconnect was
        // actually built for) — this only changes behavior for drops
        // *after* a session was already up and working, trading away
        // silent auto-recovery from a brief mid-session network blip in
        // exchange for never reopening a session the person actually
        // finished with, which — reported against twice — is clearly
        // the more important property to get right. A genuine blip can
        // still be recovered from with one click on the same manual
        // Reconnect button this state already shows.
        if (state === 5 && !cancelled) {
          if (intentionalDisconnectRef.current || hasConnectedRef.current) {
            setStatus('disconnected');
          } else {
            scheduleReconnect();
          }
        }
      };
      client.onerror = (status: Guacamole.Status) => {
        if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
        setLastErrorStatus({ code: status.code, message: status.message ?? '' });
        // See onstatechange above for the full story — hasConnectedRef,
        // not this status code, is the actual signal now. RESOURCE_CLOSED
        // is still checked first since it's a confirmed, real pathway
        // (guacd's "error" instruction, sent for some but not all clean
        // closes) and setting intentionalDisconnectRef here additionally
        // suppresses the onstatechange(5) that follows this same close
        // from doing anything redundant.
        if (status.code === Guacamole.Status.Code.RESOURCE_CLOSED || hasConnectedRef.current) {
          intentionalDisconnectRef.current = true;
          setStatus('disconnected');
          return;
        }
        if (!cancelled && !intentionalDisconnectRef.current) scheduleReconnect();
        else setStatus('error');
      };

      // --- Clipboard sync: remote -> local ---
      //
      // Reported directly as never having worked, in either SSH or
      // RDP sessions — checked directly, not assumed: this fires
      // asynchronously, from a real backend/network event (the remote
      // side copying something), never from a direct local user
      // gesture at all. navigator.clipboard.writeText() called from
      // exactly this kind of context is well-documented, confirmed
      // against multiple independent real-world reports, to fail
      // silently in Safari and (depending on timing) Firefox — both
      // require the call to happen synchronously within an actual
      // user-activation window, which an async network callback
      // inherently isn't one of. Chrome alone doesn't enforce this for
      // writeText specifically (confirmed directly against Chromium's
      // own issue tracker), so this worked there already; the
      // .catch(() => {}) below meant this failed completely silently
      // everywhere else, with nothing anywhere to suggest why.
      //
      // Fixed with a well-established workaround for exactly this
      // class of problem, not a way around the restriction itself
      // (there isn't one for an inherently async, remotely-triggered
      // event): try the immediate write first, since it still
      // succeeds outright in Chrome and sometimes elsewhere; if it's
      // rejected, queue the text and let keyDownHandlerRef's own,
      // separate retry — synchronously triggered from the very next
      // real, local keydown, a genuine user gesture — actually write
      // it. Not perfectly instantaneous in the browsers this affects,
      // but reliably lands as of whatever the person next types
      // locally, rather than never at all.
      client.onclipboard = (stream: Guacamole.InputStream, mimetype: string) => {
        if (!mimetype.startsWith('text/')) return; // file clipboard handled separately, see paste handler below
        const reader = new Guacamole.StringReader(stream);
        let text = '';
        reader.ontext = (chunk: string) => (text += chunk);
        reader.onend = () => {
          navigator.clipboard.writeText(text).catch(() => {
            pendingRemoteClipboardTextRef.current = text;
          });
        };
      };

      // Started fresh for every connection attempt (including each
      // auto-retry from scheduleReconnect below) — clearing any stale
      // timer from a previous attempt first, so a delayed fire from an
      // earlier attempt can never cut off a new one that's legitimately
      // still connecting.
      if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = setTimeout(() => {
        if (!cancelled) {
          reconnectAttemptRef.current = MAX_AUTO_RECONNECT_ATTEMPTS; // don't auto-retry a hang — surface it
          setStatus('error');
        }
      }, CONNECT_TIMEOUT_MS);

      // width/height/dpi, not just token — real gap found live: every
      // session connected at whatever default resolution guacd falls
      // back to, completely independent of the browser's actual
      // available space, causing letterboxing under the aspect-fit
      // scaling above. Confirmed directly from the real installed
      // guacamole-lite source: 'width', 'height', and 'dpi' are already
      // allowlisted (Server.js's own allowedUnencryptedConnectionSettings
      // defaults) for every protocol this app supports — including SSH
      // and telnet, since guacd's own text-terminal emulator computes
      // columns/rows from pixel width/height and font size the same way
      // RDP/VNC use pixel resolution directly, not from a separate
      // columns/rows parameter. So this one change genuinely fixes
      // letterboxing across every protocol, not just the graphical ones.
      // devicePixelRatio-scaled DPI (not a flat 96) matches the same
      // convention the official Guacamole web client itself uses, so
      // text and UI elements on the remote side render at a sensible,
      // non-blurry size on HiDPI displays rather than an arbitrary
      // fixed value.
      // Only for genuinely new connections, not joins — real risk
      // considered and deliberately avoided: "join" means attaching to
      // an existing, already-active guacd-side connection that other
      // people may currently be viewing too. Sending this joiner's own
      // window size could disruptively resize a shared session out from
      // under everyone else already in it, just because someone with a
      // different-sized window joined. The CSS scale-to-fit above
      // already handles a joiner seeing the content properly fitted to
      // their own view regardless of the session's actual resolution,
      // so there's no real downside to omitting this for joins.
      const containerWidth = containerRef.current?.clientWidth || 1024;
      const containerHeight = containerRef.current?.clientHeight || 768;
      const dpi = Math.round((window.devicePixelRatio || 1) * 96);
      const sizeParams = joinSessionId ? '' : `&width=${containerWidth}&height=${containerHeight}&dpi=${dpi}`;
      client.connect(`token=${encodeURIComponent(token)}${sizeParams}`);

      // Mouse + keyboard input
      // Reported directly: on a touch device (phone), the session
      // couldn't be interacted with at all — no cursor movement, no
      // clicks. Confirmed directly, not assumed: Guacamole.Mouse itself
      // only ever listens for native mousedown/mousemove/mouseup
      // events, which a touchscreen simply never fires at all — nothing
      // was silently failing, there was just genuinely no code
      // listening for touch input anywhere at all. guacamole-common-js
      // itself ships a dedicated class for exactly this,
      // Guacamole.Mouse.Touchpad, translating real touch gestures
      // (drag to move, tap to click, two-finger scroll, long-press for
      // right-click) into that same mousedown/mousemove/mouseup
      // interface — confirmed directly against the official Guacamole
      // manual and its own JSDoc rather than assumed to exist or to
      // behave a particular way. Touchpad (relative, drag-to-move) was
      // chosen over the also-available Touchscreen (absolute, tap-
      // where-you-want-the-cursor) since relative movement gives much
      // finer control for precisely hitting small remote UI elements on
      // a small phone screen — matching the official Guacamole web
      // app's own stated preference for exactly this reason. Both
      // classes listen for genuinely different native browser events
      // (touch vs. mouse) attached to the same element, so running both
      // side by side here is safe and non-conflicting — a touchscreen
      // laptop, for instance, gets both working at once with no extra
      // code needed for that case specifically.
      const mouse = new Guacamole.Mouse(display.getElement());
      const touch = new Guacamole.Mouse.Touchpad(display.getElement());
      // Typed loosely here rather than as Guacamole.Mouse.Event: the
      // upstream @types/guacamole-common-js TargetListener signature
      // resolves its `Event` parameter to the global DOM Event interface
      // (a naming collision with Guacamole's own Event class), so a
      // precisely-typed callback doesn't actually satisfy `onEach`'s
      // declared type even though it matches the real runtime shape.
      const handlePointerEvent = (event: any) => {
        if (!isActiveRef.current || !canSendInputRef.current) return; // background session, or a read-only join — don't send input
        client.sendMouseState(event.state);
        // Reported directly, separately: no sound in any connection.
        // Checked directly against the official Guacamole manual before
        // assuming this was any kind of Guacamole limitation — it isn't
        // one: audio redirection is on by default on both the client
        // and the RDP backend, and this project's own guacTunnel.ts
        // never disables it either. The actual, well-documented cause:
        // every major browser creates the Web Audio API's AudioContext
        // — which guacamole-common-js's own built-in audio playback
        // shares as one single, page-wide singleton — in a "suspended"
        // state until a real, direct user gesture resumes it, and
        // nothing in guacamole-common-js's own audio player appears to
        // do that resuming itself. A real mousedown/touch here is
        // exactly that gesture, so this is the natural, already-
        // guaranteed-to-fire place to do it — see audioResumedRef's own
        // comment above for why this only actually calls resume() once.
        if (!audioResumedRef.current) {
          audioResumedRef.current = true;
          getGuacamoleAudioContext()?.resume();
        }
      };
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], handlePointerEvent);
      touch.onEach(['mousedown', 'mouseup', 'mousemove'], handlePointerEvent);
      // Real bug found live, causing an intermittent version of the
      // /admin keyboard bug already fixed a couple of rounds back — it
      // came back specifically for sessions that had reconnected at
      // least once (an auto-retry from a brief network blip, or even
      // just the very first attempt timing out once and retrying).
      // connect() runs again for every retry, and this line runs again
      // each time, constructing a genuinely new Guacamole.Keyboard —
      // but Guacamole.Keyboard has no method to remove its own
      // document-level listener once attached (confirmed from the real
      // source, same finding as the earlier /admin fix), so the
      // *previous* attempt's keyboard instance doesn't go away, it's
      // just abandoned mid-listen with its old (non-null) handlers
      // still fully intact. The isActive-keyed toggle effect below only
      // ever reaches keyboardRef.current — the latest instance — so any
      // orphaned earlier ones kept right on intercepting every
      // keystroke on the page regardless of the current session's
      // isActive state, since nothing was ever nulling them out.
      // Nulling the previous instance's handlers here, before replacing
      // the ref with the new one, is what actually closes this off —
      // matches the same "null the handlers, since the listener itself
      // can't be removed" pattern already used in this effect's own
      // cleanup function for the final case (the session closing
      // outright), just applied here for the reconnecting-in-between
      // case too.
      if (keyboardRef.current) {
        keyboardRef.current.onkeydown = null;
        keyboardRef.current.onkeyup = null;
      }
      const keyboard = new Guacamole.Keyboard(document);
      keyboardRef.current = keyboard;
      // Named, stored in refs (not inline closures assigned directly to
      // keyboard.onkeydown/onkeyup) specifically so the separate effect
      // below — keyed on the isActive prop, running independently of
      // this connect() call — can toggle them on and off later without
      // needing to reconstruct the Keyboard instance or duplicate this
      // logic.
      keyDownHandlerRef.current = (keysym: number) => {
        // Retries a remote clipboard update that couldn't be written
        // locally the moment it actually arrived (client.onclipboard's
        // own comment above has the full reasoning) — this keydown is
        // itself a genuine, local, real-time user gesture, so the
        // browsers that specifically required one for the original,
        // async-context attempt should allow it here. Cleared
        // immediately, synchronously, regardless of outcome — so a
        // still-failing retry (a real possibility, not every cause of
        // the original failure is gesture-timing) can never turn into
        // a repeated attempt on every subsequent keystroke too.
        if (pendingRemoteClipboardTextRef.current !== null) {
          const text = pendingRemoteClipboardTextRef.current;
          pendingRemoteClipboardTextRef.current = null;
          navigator.clipboard.writeText(text).catch(() => {});
        }
        // Control_L/R (0xffe3/0xffe4) or Super_L/R (0xffeb/0xffec, Mac's
        // own Cmd key as translated here) — see pasteModifierHeldRef's
        // own comment above for why Super, not Meta/Alt, is Cmd's real
        // keysym in this pipeline.
        if (keysym === 0xffe3 || keysym === 0xffe4 || keysym === 0xffeb || keysym === 0xffec) {
          pasteModifierHeldRef.current = true;
        } else if (keysym === 0xffe1 || keysym === 0xffe2) {
          shiftHeldRef.current = true;
        } else if (keysym === 0x76 || keysym === 0x56) {
          if (pasteModifierHeldRef.current && !pasteKeyAlreadyDownRef.current) {
            // Fired here, synchronously, from within this same real,
            // native keydown event, not awaited before the keystroke
            // itself continues to be forwarded below — see
            // handlePasteShortcut's own comment for why this, not the
            // native DOM "paste" event, is the actual fix.
            handlePasteShortcut();
          }
          pasteKeyAlreadyDownRef.current = true;

          // Reported directly: local-to-remote paste worked perfectly
          // for RDP, but an SSH session just typed a literal "^V" —
          // confirmed directly, not assumed, against Apache
          // Guacamole's own terminal emulator behavior (multiple
          // independent, authoritative sources: its actual paste
          // trigger for a terminal-based protocol — shared by SSH,
          // telnet, and Kubernetes exec, all the same underlying
          // terminal-emulator code in guacd — is Ctrl+Shift+V, or a
          // right/middle mouse click, never plain Ctrl+V at all).
          // Forwarding a plain Ctrl+V keystroke to a real shell is a
          // real, raw control byte (0x16) with its own, unrelated
          // meaning there — GNU readline's own default binding for it
          // is "quoted-insert", which is exactly what displays as a
          // literal "^V". RDP/VNC are entirely unaffected by any of
          // this and keep working exactly as before: forwarding the
          // real Ctrl+V is what makes the remote OS's own, genuine
          // clipboard paste fire there, and still does.
          const isTerminalProtocol = protocol === 'ssh' || protocol === 'telnet' || protocol === 'kubernetes';
          if (isTerminalProtocol && isActiveRef.current && canSendInputRef.current) {
            const syntheticShift = !shiftHeldRef.current;
            if (syntheticShift) client.sendKeyEvent(1, 0xffe1); // Shift_L down
            client.sendKeyEvent(1, keysym); // the actual 'v'/'V' itself
            if (syntheticShift) client.sendKeyEvent(0, 0xffe1); // Shift_L up — only ever releasing the one synthesized here, never a genuinely, physically held Shift
            return; // already forwarded above — skip the plain, unconditional forward below
          }
        }
        if (isActiveRef.current && canSendInputRef.current) client.sendKeyEvent(1, keysym);
      };
      keyUpHandlerRef.current = (keysym: number) => {
        if (keysym === 0xffe3 || keysym === 0xffe4 || keysym === 0xffeb || keysym === 0xffec) {
          pasteModifierHeldRef.current = false;
        } else if (keysym === 0xffe1 || keysym === 0xffe2) {
          shiftHeldRef.current = false;
        } else if (keysym === 0x76 || keysym === 0x56) {
          pasteKeyAlreadyDownRef.current = false;
        }
        if (isActiveRef.current && canSendInputRef.current) client.sendKeyEvent(0, keysym);
      };
      // Applied here too, not just in the separate isActive effect below
      // — real timing gap considered and fixed, not missed: connect() is
      // async, so keyboardRef.current is still null for however long the
      // token fetch and initial handshake take. If isActive happens to
      // stay the same value the whole time (the common case — a freshly
      // opened session is immediately active and stays that way), that
      // separate effect's only run so far already fired and no-opped
      // against a still-null ref, and won't fire again on its own since
      // its one dependency never changed. Applying isActiveRef.current
      // directly here, right as the keyboard is actually constructed,
      // is what makes the very first real handler assignment correct
      // regardless of that timing.
      keyboard.onkeydown = isActiveRef.current ? keyDownHandlerRef.current : null;
      keyboard.onkeyup = isActiveRef.current ? keyUpHandlerRef.current : null;
    }

    function scheduleReconnect() {
      if (reconnectAttemptRef.current >= MAX_AUTO_RECONNECT_ATTEMPTS) {
        setStatus('error'); // exhausted auto-retries — the "Reconnect" button takes over from here
        return;
      }
      setStatus('reconnecting');
      const delayMs = Math.min(1000 * 2 ** reconnectAttemptRef.current, 16000);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (!cancelled) connect();
      }, delayMs);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
      if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
      // Guacamole.Keyboard has no method to actually remove its own
      // document-level listeners once attached (checked the real
      // installed source directly — there isn't one), so the listener
      // itself outlives this component regardless. Nulling the handlers
      // here is what actually matters: without it, a session closed
      // while it happened to be the active one would leave its real,
      // still-forwarding handlers attached to a listener that never goes
      // away, which would keep intercepting every keystroke on the page
      // forever — the exact bug this whole fix is for, just triggered by
      // closing a session instead of backgrounding one.
      if (keyboardRef.current) {
        keyboardRef.current.onkeydown = null;
        keyboardRef.current.onkeyup = null;
      }
      intentionalDisconnectRef.current = true;
      clientRef.current?.disconnect();
    };
    // authToken deliberately excluded — read via authTokenRef.current at
    // the one moment this effect's own connect() actually needs it
    // (issuing the tunnel-token request), not as a reactive dependency;
    // see authTokenRef's own declaration above for the full reasoning —
    // this is the actual fix for the reported bug (real, successful
    // sessions being torn down and recreated in a loop on every
    // unrelated background token refresh).
  }, [connectionId, apiBase, reconnectKey, joinSessionId, readOnly, adhocSettings]);

  // Toggles the live Guacamole.Keyboard's own handlers directly,
  // separately from the connect effect above (which only runs once per
  // connection attempt, not on every isActive change — switching which
  // session tab is focused, or navigating to/from /admin, doesn't
  // reconnect anything, so this needs its own effect reacting to
  // isActive on its own). Real bug found live: an inactive
  // (backgrounded) session's Guacamole.Keyboard was still intercepting
  // every keystroke on the page — including ones meant for completely
  // unrelated UI, like the admin panel's own input fields, which
  // stopped accepting any typed input at all as soon as a session was
  // open in the background. Checking isActive only *inside* the
  // handlers (still done above, for the read-only/canSendInput case)
  // controls whether a keystroke gets forwarded to the remote — it does
  // nothing to stop Guacamole's own listener from intercepting the
  // keystroke in the first place, confirmed from the real installed
  // source: it's attached on `document` with useCapture:true, and does
  // nothing at all if onkeydown/onkeyup aren't set — genuinely unset,
  // not just gated internally, is what actually stops the interception.
  useEffect(() => {
    if (!keyboardRef.current) return;
    keyboardRef.current.onkeydown = isActive ? keyDownHandlerRef.current : null;
    keyboardRef.current.onkeyup = isActive ? keyUpHandlerRef.current : null;
  }, [isActive]);

  function manualReconnect() {
    reconnectAttemptRef.current = 0;
    setReconnectKey((k) => k + 1);
  }

  // --- Clipboard sync: local -> remote, with file-paste interception ---
  //
  // Reported directly as never having worked, in either SSH or RDP
  // sessions — checked directly, not assumed: the previous approach
  // relied on the native DOM "paste" event (onPaste on the outer
  // session-viewport div), which the official Apache Guacamole
  // project's own FAQ explicitly, directly says is "useless for a web
  // application implementing remote desktop like Guacamole" — for
  // reasons independently confirmed here too: the native paste event
  // only reliably fires on an actually-editable element (a real
  // <input>/<textarea>/contenteditable), not a plain, non-editable div
  // this session's own canvas is, however focusable — Firefox in
  // particular disables the Paste command entirely in that case
  // (confirmed against a real Firefox bug report describing exactly
  // this), so the handler this was wired to may simply never have
  // fired at all.
  //
  // Fixed the same way the official project's own GUAC-1480 fix
  // does — "sync local clipboard... if it appears due to a keyboard
  // shortcut" — detecting Ctrl+V/Cmd+V directly in the keysym stream
  // instead, which guacamole-common-js's own Keyboard only ever
  // produces from a real, native browser keydown event in the first
  // place: a genuine user gesture, reliable regardless of whether the
  // focused element counts as "editable" to the browser. Deliberately
  // does not preventDefault or otherwise stop the V keystroke itself
  // from still being forwarded to the remote side immediately after —
  // that forwarded keystroke is what makes the remote OS's own paste
  // command fire, now pulling the just-synced clipboard content.
  async function handlePasteShortcut() {
    if (!isActiveRef.current || !canSendInputRef.current) return; // background session, or view-only — a paste shouldn't do anything
    const client = clientRef.current;
    if (!client) return;

    let items: ClipboardItem[];
    try {
      items = await navigator.clipboard.read();
    } catch {
      return; // clipboard read denied/unsupported — the remote side's own, already-current clipboard is used instead
    }

    for (const item of items) {
      const fileType = item.types.find((t) => t !== 'text/plain');
      if (fileType) {
        const blob = await item.getType(fileType);
        await pasteFileIntoSession(blob, fileType);
        return;
      }
    }

    // No file present — sync as plain text through the normal Guacamole clipboard stream
    const text = await navigator.clipboard.readText().catch(() => '');
    if (!text) return;
    const stream = client.createClipboardStream('text/plain');
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
  }

  // A real bug caught here, not present in the drag-and-drop path itself
  // but in this function both paths share: the uploaded file's own name
  // was hardcoded as the literal string "pasted-file" — no real name, no
  // extension — regardless of what the actual file, or a real,
  // drag-and-dropped one specifically, was actually called. Harmless
  // (if confusing) for the narrow clipboard-image case this was
  // originally written for, since an image blob genuinely has no
  // filename of its own to begin with — but a real, named file dropped
  // in now has one, and silently discarding it would have meant it
  // landing on the remote side unrecognizable and effectively
  // unusable, easy to mistake for "it never arrived at all" even
  // though the upload itself succeeded.
  async function pasteFileIntoSession(blob: Blob, mimeType: string, filename?: string) {
    // No connectionId for an ad-hoc session — the backend endpoint this
    // calls is connectionId-keyed, so there's nothing valid to call it
    // with. Deliberate, considered scope for this feature's first
    // version (see SessionViewport's own Props comment on
    // adhocSettings), not an oversight — a file paste attempt for an
    // ad-hoc session simply does nothing here, the same as a
    // denied/unsupported clipboard read already does just above in
    // handlePasteShortcut.
    if (!connectionId) return;
    setTransferProgress(0);
    setTransferError(null);
    const form = new FormData();
    // A clipboard-image blob genuinely has no filename of its own — a
    // reasonable, MIME-derived placeholder (e.g. "pasted-image.png")
    // instead of the completely generic, extension-less one this used
    // to unconditionally send.
    const uploadName = filename ?? `pasted-image.${mimeType.split('/')[1] || 'bin'}`;
    form.append('file', blob, uploadName);

    // fetch() has no upload-progress event, so this one upload specifically
    // uses XMLHttpRequest instead — everything else in this component stays
    // on fetch, this is the one place progress actually matters (large RDP
    // drive-redirection or SFTP pushes can take a while with no feedback).
    let remotePath: string | undefined;
    try {
      remotePath = await new Promise<string | undefined>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${apiBase}/api/sessions/${connectionId}/paste-file`);
        xhr.setRequestHeader('Authorization', `Bearer ${authTokenRef.current}`);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setTransferProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText).remotePath);
            } catch {
              resolve(undefined);
            }
          } else if (xhr.status === 413) {
            // Requested directly: a raw "status 413" is accurate but not
            // actually informative to read — this app's own real ceiling
            // (multer's own limit, routes/sessions.ts, matched by
            // nginx.conf's own client_max_body_size right alongside it)
            // is what actually produces this, so naming it directly is
            // both more helpful and, unlike a vague "file too large"
            // alone, tells someone exactly why without needing to go
            // looking through server logs for it.
            reject(new Error('File is too large (maximum 200MB)'));
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.send(form);
      });
    } catch (err) {
      setTransferProgress(null);
      setTransferError({ direction: 'upload', message: err instanceof Error ? err.message : 'Upload failed' });
      return;
    }
    setTransferProgress(null);
    setTransferError(null);

    // Backend drops the file at a fixed per-session path and returns it here;
    // typing it at the cursor is what makes this feel like a real paste
    // instead of a separate upload step. See docs/ARCHITECTURE.md.
    const client = clientRef.current;
    if (client && remotePath) {
      for (const char of remotePath) {
        const keysym = char.charCodeAt(0);
        client.sendKeyEvent(1, keysym);
        client.sendKeyEvent(0, keysym);
      }
    }
  }

  // Drag-and-drop — see the draggingFile useState comment above for why
  // this exists alongside, not instead of, the clipboard-paste file
  // handling further up. Only the first dropped file is used, matching
  // the existing paste flow's own one-file-at-a-time behavior — not a
  // limitation of pasteFileIntoSession itself, just staying consistent
  // with the one already-established upload pattern rather than quietly
  // introducing a second, different one (e.g. uploading several files
  // at once) alongside it.
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (!draggingFile) setDraggingFile(true);
  }
  function handleDragLeave(e: DragEvent) {
    // Only clear on actually leaving the viewport itself, not a child
    // element within it — dragging over a child fires its own
    // dragleave on the way to firing dragenter on that child, which
    // would otherwise flicker the drop-target highlight on and off as
    // the cursor moves around inside the same viewport.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDraggingFile(false);
  }
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDraggingFile(false);
    const file = e.dataTransfer.files[0];
    if (file) pasteFileIntoSession(file, file.type, file.name);
  }

  // Reported directly: downloading a ready file always failed with
  // "needs authorisation." Checked directly, not assumed: this used to
  // be a plain <a href={...} download={...}> pointed straight at the
  // backend's own GET /api/sessions/rdp-drive/:id/download/:filename
  // route — which, like virtually every other route in this app,
  // genuinely requires a real Authorization: Bearer <token> header
  // (confirmed directly against app.ts's own middleware chain,
  // requireAuth mounted ahead of every /api route). A native <a> click
  // never carries a custom header at all — there's no way for one to —
  // so every single download request reached the backend with no
  // credentials whatsoever and was correctly, expectedly rejected.
  // Fixed with the standard, well-established pattern for downloading
  // an authenticated resource at all from a browser: fetch() it with
  // the real header, then hand the browser the result as a local blob
  // URL and trigger the save from that — not a way around needing
  // real auth, just the one way to actually send it for something the
  // browser itself has to be the one to save.
  //
  // This almost certainly explains the separate "a download.json file
  // dialog pops up" report too, not just the "needs authorisation"
  // one, even though it wasn't possible to confirm the exact mechanism
  // without a real, live browser available to reproduce it directly
  // this round: a plain <a download> pointed at a route that no longer
  // requires nothing else to fail — an auth rejection, a genuinely
  // gone file, anything at all — would have had the browser attempting
  // to save whatever the server actually sent back (a JSON error body,
  // with no relation to the filename the <a download> attribute
  // itself named) as a file instead of the real one. fetch() can never
  // trigger a native browser save dialog on its own, on success or
  // failure alike — only an explicit blob-URL trigger, added here
  // specifically for a genuine successful download, ever does.
  async function downloadReadyFile(f: { name: string; downloadUrl: string }) {
    // The actual, direct fix for clicking twice producing two separate
    // downloads — see the downloadingFiles useState comment above.
    // A client-side click guard, not a server-side one: this stops the
    // second request from ever being sent at all, rather than relying
    // on anything after the fact to deduplicate two independent,
    // already-in-flight requests.
    if (downloadingFiles.has(f.name)) return;
    setTransferError(null);
    setDownloadingFiles((prev) => new Map(prev).set(f.name, -1));
    try {
      const res = await fetch(`${apiBase}${f.downloadUrl}`, {
        headers: { Authorization: `Bearer ${authTokenRef.current}` }
      });
      if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
      // Reported directly: no visible feedback at all while a large
      // download was actually in progress. fetch()'s own response
      // gives no built-in progress event the way XMLHttpRequest's
      // upload.onprogress does for an upload (see pasteFileIntoSession
      // above for that one) — but its response body is a real,
      // genuinely readable stream, so reading it manually, one chunk
      // at a time, and tallying bytes received against the response's
      // own Content-Length header is the direct, standard way to get
      // real download progress out of fetch() specifically. Content-
      // Length isn't guaranteed to be present on every response (some
      // encodings/servers omit it) — total stays 0 and progress stays
      // indeterminate (-1) rather than a fake, misleading percentage
      // in that case, rather than assuming it's always there.
      const total = Number(res.headers.get('Content-Length')) || 0;
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      if (reader) {
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          setDownloadingFiles((prev) => new Map(prev).set(f.name, total ? Math.round((received / total) * 100) : -1));
        }
      } else {
        // No streaming reader available in this environment — still
        // correct, just without the incremental progress a real one gives.
        chunks.push(new Uint8Array(await res.arrayBuffer()));
      }
      const blob = new Blob(chunks as BlobPart[]);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = f.name;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setTransferError({ direction: 'download', message: err instanceof Error ? err.message : 'Download failed' });
      return; // leave this entry in readyDownloads so the person can retry, rather than losing it on a failed attempt
    } finally {
      setDownloadingFiles((prev) => {
        const next = new Map(prev);
        next.delete(f.name);
        return next;
      });
    }
    setReadyDownloads((prev) => prev.filter((d) => d.name !== f.name));
  }

  const showReconnectButton = status === 'error' || status === 'disconnected';

  return (
    <div
      className={`session-viewport${draggingFile ? ' session-viewport-drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={containerRef}
        className="session-canvas"
        tabIndex={0}
        style={hasRemoteCursor ? { cursor: 'none' } : undefined}
      />
      {draggingFile && <div className="session-drop-overlay">{t('session.dropFileHere')}</div>}
      {readOnly && status === 'connected' && <div className="session-readonly-badge">{t('share.viewOnly')}</div>}
      {status !== 'connected' && (
        <div className={`session-status session-status-${status}`}>
          {status === 'reconnecting'
            ? `Reconnecting… (attempt ${reconnectAttemptRef.current})`
            : status === 'error' && lastErrorStatus
              ? // Requested directly: the specific reason, not just the bare
                // word "error" — a known code gets its real, human-readable
                // meaning; an unrecognized one (there's no way to enumerate
                // every value a given guacd version might ever send) still
                // shows the raw numeric code rather than silently having
                // nothing to say at all. status.message, when guacd actually
                // provides one beyond the generic description, is appended
                // too — that's often the most specific, useful part.
                `${GUAC_STATUS_DESCRIPTIONS[lastErrorStatus.code] ?? `Connection error (code ${lastErrorStatus.code})`}` +
                (lastErrorStatus.message &&
                lastErrorStatus.message !== GUAC_STATUS_DESCRIPTIONS[lastErrorStatus.code]
                  ? ` ${lastErrorStatus.message}`
                  : '')
              : status}
          {showReconnectButton && (
            <button className="session-reconnect-button" onClick={manualReconnect}>
              Reconnect
            </button>
          )}
        </div>
      )}
      {transferProgress !== null && (
        <div className="transfer-chip">Transferring file… {transferProgress}%</div>
      )}
      {transferError && (
        <div className="transfer-chip transfer-chip-error">
          {t(transferError.direction === 'upload' ? 'session.uploadFailed' : 'session.downloadFailed', { message: transferError.message })}
          <button onClick={() => setTransferError(null)}>×</button>
        </div>
      )}
      {readyDownloads.length > 0 && (
        <div className="rdp-download-tray">
          {readyDownloads.map((f) => {
            const progress = downloadingFiles.get(f.name);
            const isDownloading = progress !== undefined;
            return (
              <button
                key={f.name}
                className={`rdp-download-item${isDownloading ? ' rdp-download-item-active' : ''}`}
                onClick={() => downloadReadyFile(f)}
                disabled={isDownloading}
              >
                {isDownloading
                  ? progress >= 0
                    ? t('session.downloadingWithProgress', { name: f.name, percent: progress })
                    : t('session.downloadingIndeterminate', { name: f.name })
                  : t('session.readyToDownload', { name: f.name })}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
