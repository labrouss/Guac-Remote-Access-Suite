import { useEffect, useRef, useState } from 'react';
import { Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { VersionBadge } from './VersionBadge';
import { ConnectionPanel } from './ConnectionPanel';
import { DemoPanel } from './DemoPanel';
import { SessionViewport } from './SessionViewport';
import { RecordButtonStrip } from './RecordButtonStrip';
import { ShareSessionButton } from './ShareSessionButton';
import { UnmuteButton } from './UnmuteButton';
import { ShareNotifications } from './ShareNotifications';
import { AdhocConnectionModal } from './AdhocConnectionModal';
import { ThemePicker } from './ThemePicker';
import { LanguagePicker } from './LanguagePicker';
import { HelpPanel } from './HelpPanel';
import { SessionOverview } from './SessionOverview';
import { SessionMenu } from './SessionMenu';
import { UserMenu } from './UserMenu';
import { AdminPanel } from './AdminPanel';
import { MyListPage } from './MyListPage';

const API_BASE = ''; // same-origin; nginx proxies /api to the backend

interface OpenSession {
  key: string;
  /** Absent for an ad-hoc connection (see adhocSettings below) — there's
   * no saved connection row to reference at all in that case. */
  connectionId?: string;
  protocol: string;
  name: string;
  /** Real backend `sessions.id`, learned only after connecting (new
   * connections) or known upfront (joins) — see SessionViewport's
   * onSessionReady. Record/Share are wired to this, not connectionId;
   * conflating the two was a real, previously-shipped bug (the record
   * endpoint expects sessions.id, a different UUID space entirely). */
  realSessionId: string | null;
  /** True if this slot is joining someone else's live session rather than
   * a connection this user opened themselves — joiners don't get
   * Record/Share controls, since they don't own the session. */
  isJoin?: boolean;
  readOnly?: boolean;
  /** Set for an ad-hoc connection — see SessionViewport's own Props
   * comment on the identical prop for the full reasoning on why this
   * kind of session deliberately skips Record/Share/file-transfer. */
  adhocSettings?: {
    protocol: string;
    hostname: string;
    port: number;
    username: string;
    password: string;
    params?: Record<string, unknown>;
  };
}

/**
 * The persistent app shell — owns session state, the header, and every
 * open SessionViewport, and renders `/` (connections/demos) and `/admin`
 * as *nested* routes within itself rather than as separate top-level
 * routes.
 *
 * This replaces the old split where MainApp (`/`) and AdminPanel
 * (`/admin`) were entirely separate top-level `<Route>` elements in
 * App.tsx. Found live: every open session actually died the moment
 * someone visited the admin panel and came back. React Router fully
 * unmounts a route's component tree when navigating to a different
 * top-level route, and every open SessionViewport's cleanup effect calls
 * `client.disconnect()` on unmount — so this wasn't just losing the UI,
 * it was genuinely terminating the connection server-side. Nesting
 * `/admin` inside this persistent shell (a standard React Router
 * "layout route" pattern) means navigating between the two never
 * unmounts this component, its session state, or any SessionViewport —
 * only the swappable "main content" region underneath changes.
 */
export function AppShell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // Real gap caught before shipping, not after: this used to be
  // onManagementRoute, checking only '/admin' — every one of its uses is
  // about hiding/disabling the session-viewport layer and its keyboard
  // capture while on a full-page management view, not specifically
  // about admin status. /my-connections is exactly that same kind of
  // view (full-page connection/folder/bookmark management, just scoped
  // to a personal list instead of admin-wide), so it needs identical
  // treatment — an active session's keyboard capturing keystrokes there
  // would block typing into its own forms, the same bug already fixed
  // for /admin, ConnectionPanel, the share popover, etc. in earlier
  // rounds. Renamed to onManagementRoute since "admin" was no longer an
  // accurate name for what this actually gates.
  const onManagementRoute = location.pathname.startsWith('/admin') || location.pathname.startsWith('/my-connections');

  const [view, setView] = useState<'connections' | 'demos'>('connections');
  // Requested directly: dismissing the demo panel required explicitly
  // clicking the "Connections" tab again — clicking anywhere else
  // (an open session, empty space) did nothing. Not a backdrop the way
  // ConnectionPanel's own click-outside-to-close works (panel-backdrop,
  // above) — that's a deliberate difference, not an oversight:
  // ConnectionPanel is a hover-triggered overlay where blocking the
  // click from reaching whatever's underneath is fine, but here the
  // most natural "click away" is clicking directly into an open
  // session to actually use it, and that same click should both
  // dismiss the demo panel AND still reach the session underneath to
  // focus it — not be swallowed by a blocking backdrop, requiring a
  // second click to actually do anything.
  // mousedown, not click: fires before the header's own view-toggle
  // buttons' onClick, so switching to "Demos" while already on
  // "Connections" (or vice versa) can't race with this listener and
  // flicker view back and forth within the same physical click.
  const demoPanelDockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view !== 'demos') return;
    function handleClickAway(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (demoPanelDockRef.current?.contains(target)) return;
      if (target.closest('.view-toggle')) return; // let that button's own handler decide view instead
      setView('connections');
    }
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [view]);
  const [openSessions, setOpenSessions] = useState<OpenSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  // Requested directly ("ad-hoc connections"): whether the current user is
  // a global admin — the real enforcement lives server-side
  // (requireAdmin on GET /admin/am-i-admin itself, and again independently
  // on the actual token-issuing route, routes/tunnelToken.ts's
  // issueAdhocConnectionToken), this is purely so the "Quick connect"
  // button below never even shows itself to someone it would just reject
  // after they'd already filled out the whole form. Starts null (not
  // shown, but not yet KNOWN not-admin either) until the check
  // resolves, rather than flashing the button briefly for every user on
  // every load — also now what AdminPanel itself uses (passed down
  // below) to tell "still checking" apart from "confirmed not admin":
  // collapsing this to a plain boolean starting false would otherwise
  // flash a real admin their own "you don't have permission" message
  // for a moment on every direct /admin visit, while this same fetch is
  // still in flight.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [showAdhocModal, setShowAdhocModal] = useState(false);
  // Real bug found live: opening the connections side panel (or its own
  // "Add connection"/bookmark forms within it) made it impossible to
  // type into those forms whenever a session was open behind it — the
  // exact same root cause as the earlier /admin keyboard bug, just a
  // different trigger. The active session's Guacamole.Keyboard has no
  // way to know this panel exists or is currently covering part of the
  // screen; it just keeps intercepting every keystroke regardless.
  // Folded into the same isActive calculation below (alongside
  // onManagementRoute, helpOpen, and overviewOpen — the latter two weren't
  // actually covered before this fix either, just never specifically
  // reported, likely because neither has a text input for the gap to
  // show up as obviously as it does here) so the fix generalizes to any
  // overlay that ever sits on top of a session, rather than needing a
  // one-off for each one individually.
  const [panelOpen, setPanelOpen] = useState(false);
  // Same bug, same fix, different trigger — reported directly this time.
  // ShareSessionButton's own popover (with UserPicker's search input
  // inside it) is only ever rendered for the currently active session
  // (see the session-slot map below: gated on `s.key === activeKey`),
  // so — like panelOpen above — a single global boolean is correct here;
  // there's never more than one ShareSessionButton mounted at once to
  // need per-session tracking.
  const [shareOpen, setShareOpen] = useState(false);
  const authToken = sessionStorage.getItem('guac.sessionToken') ?? '';

  useEffect(() => {
    fetch(`${API_BASE}/api/admin/am-i-admin`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false));
  }, [authToken]);

  // Refs mirroring the latest state, read from the keyboard-shortcut
  // listener below — that listener is registered once (empty dependency
  // array) rather than re-bound on every session open/close/switch, both
  // for simplicity and to avoid losing track of "Ctrl/Alt are currently
  // held" mid-hold if the effect were to rebind between two quick
  // shortcut presses.
  const openSessionsRef = useRef(openSessions);
  openSessionsRef.current = openSessions;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  // Remembers which connections were open across a genuine browser
  // refresh — requested directly. Important to be upfront about what
  // this actually does, in the code and to anyone reading it: a real
  // page reload destroys the entire JS runtime and every live WebSocket
  // tunnel with it, so this cannot and does not resume the *same* live
  // session — no scroll position, shell history, or cursor position
  // survives. What it does do is remember *which* connections were open
  // and automatically reopen fresh sessions to the same targets, so the
  // workspace comes back looking the same rather than the person having
  // to manually reopen each one by hand. sessionStorage specifically
  // (not localStorage), matching the existing auth token's own storage
  // choice — scoped to this browser tab's session and gone once the tab
  // or browser closes, rather than persisting indefinitely and trying to
  // restore a workspace from days ago.
  //
  // Deliberately excludes joined sessions (isJoin) — rejoining requires
  // the *original* session, owned by someone else, to still be active,
  // which is entirely outside this tab's control; blindly attempting
  // that on every single refresh could fail in ways that aren't obvious
  // to fix, unlike a regular connection which just reopens cleanly.
  const RESTORE_STORAGE_KEY = 'guac.openConnections';
  // Real bug found live: both effects below run on every mount,
  // including the very first one after a genuine refresh — and React
  // runs them in declaration order, synchronously, within the same
  // effects pass. The persist effect ran *first*, saw openSessions still
  // empty (true on every fresh mount, before restore has had any chance
  // to run), and immediately deleted the stored data via
  // sessionStorage.removeItem — before the restore effect below ever
  // got to read it. Simply reordering the two effects doesn't fix this
  // either: restore's own setOpenSessions calls don't take effect until
  // the *next* render, so even running second, persist would still see
  // the same stale empty array from this same mount's initial closure.
  // This ref gates the persist effect from doing anything at all until
  // restore has genuinely had its turn — set unconditionally inside the
  // restore effect below, regardless of whether it found anything to
  // restore, so a completely fresh session (nothing to restore) doesn't
  // permanently block persisting either.
  const hasAttemptedRestoreRef = useRef(false);

  useEffect(() => {
    if (!hasAttemptedRestoreRef.current) return;
    const toPersist = openSessions
      .filter((s) => !s.isJoin)
      .map((s) => ({ connectionId: s.connectionId, protocol: s.protocol, name: s.name }));
    const activeConnectionId = openSessions.find((s) => s.key === activeKey && !s.isJoin)?.connectionId ?? null;
    if (toPersist.length === 0) {
      sessionStorage.removeItem(RESTORE_STORAGE_KEY);
    } else {
      sessionStorage.setItem(RESTORE_STORAGE_KEY, JSON.stringify({ connections: toPersist, activeConnectionId }));
    }
  }, [openSessions, activeKey]);

  // Runs once, on mount only — restoring after a genuine refresh, not
  // reacting to ongoing changes (the effect above already handles
  // keeping the stored list up to date as sessions open and close
  // normally). The previously-active connection is deliberately opened
  // *last*: openConnection makes whatever it just opened the active one,
  // so opening everything else first and the active one last is what
  // naturally lands on the right one being active again afterward,
  // without needing to separately track and match up session keys that
  // don't exist yet at the point this runs.
  useEffect(() => {
    const raw = sessionStorage.getItem(RESTORE_STORAGE_KEY);
    if (!raw) {
      hasAttemptedRestoreRef.current = true;
      return;
    }
    try {
      const { connections, activeConnectionId } = JSON.parse(raw) as {
        connections: { connectionId: string; protocol: string; name: string }[];
        activeConnectionId: string | null;
      };
      const ordered = [...connections].sort((a, b) => {
        if (a.connectionId === activeConnectionId) return 1;
        if (b.connectionId === activeConnectionId) return -1;
        return 0;
      });
      for (const c of ordered) openConnection(c.connectionId, c.protocol, c.name);
    } catch {
      sessionStorage.removeItem(RESTORE_STORAGE_KEY); // malformed — don't keep tripping over it on every future load
    } finally {
      hasAttemptedRestoreRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goToConnectionsView(next: 'connections' | 'demos') {
    setView(next);
    if (onManagementRoute) navigate('/');
  }

  function openConnection(connectionId: string, protocol: string, name: string) {
    if (onManagementRoute) navigate('/'); // opening a connection should bring the workspace into view
    setOpenSessions((prev) => {
      const existing = prev.find((s) => s.connectionId === connectionId && !s.isJoin);
      if (existing) {
        setActiveKey(existing.key);
        return prev;
      }
      const key = `${connectionId}-${Date.now()}`;
      setActiveKey(key);
      return [...prev, { key, connectionId, protocol, name, realSessionId: null }];
    });
  }

  // Opens a live-shared session someone else granted access to — see
  // SessionMenu's "Shared with you" section below.
  function joinSession(sessionId: string, connectionId: string, protocol: string, name: string, readOnly: boolean) {
    if (onManagementRoute) navigate('/');
    setOpenSessions((prev) => {
      const existing = prev.find((s) => s.realSessionId === sessionId && s.isJoin);
      if (existing) {
        setActiveKey(existing.key);
        return prev;
      }
      const key = `join-${sessionId}-${Date.now()}`;
      setActiveKey(key);
      return [
        ...prev,
        { key, connectionId, protocol, name: `${name} (shared)`, realSessionId: sessionId, isJoin: true, readOnly }
      ];
    });
  }

  // Requested directly ("ad-hoc connections"): opens a new session tab
  // from settings typed directly into AdhocConnectionModal, rather than
  // from a saved connection — no connectionId at all (there's no saved
  // row to have one), and adhocSettings carries everything
  // SessionViewport needs to request its own token directly. Always a
  // new tab, unlike joinSession's own de-duplication against an
  // already-open one — there's no stable identity to de-duplicate
  // against here at all (an ad-hoc connection has no id of its own, only
  // whatever was typed into the form a moment ago).
  function openAdhocConnection(settings: NonNullable<OpenSession['adhocSettings']>) {
    if (onManagementRoute) navigate('/');
    const key = `adhoc-${Date.now()}`;
    setOpenSessions((prev) => [
      ...prev,
      { key, protocol: settings.protocol, name: `${settings.hostname} (ad-hoc)`, realSessionId: null, adhocSettings: settings }
    ]);
    setActiveKey(key);
    setShowAdhocModal(false);
  }

  function setRealSessionId(key: string, realSessionId: string) {
    setOpenSessions((prev) => prev.map((s) => (s.key === key ? { ...s, realSessionId } : s)));
  }

  function closeSession(key: string) {
    setOpenSessions((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      const next = prev.filter((s) => s.key !== key);
      if (activeKeyRef.current === key) {
        const fallback = next[Math.max(0, idx - 1)] ?? next[0] ?? null;
        setActiveKey(fallback?.key ?? null);
      }
      return next;
    });
  }

  function cycle(direction: 1 | -1) {
    const sessions = openSessionsRef.current;
    if (sessions.length < 2) return;
    const idx = sessions.findIndex((s) => s.key === activeKeyRef.current);
    const nextIdx = (idx + direction + sessions.length) % sessions.length;
    setActiveKey(sessions[nextIdx].key);
  }

  // Ctrl+Alt+Left/Right to cycle sessions, Ctrl+Alt+Up for the overview —
  // the LEFT-hand Ctrl and Alt specifically (not AltGr, which many
  // international keyboard layouts send as a combined right-Alt+Ctrl for
  // producing accented characters — binding to left-side modifiers avoids
  // hijacking that). Registered on `window` with capture:true so this runs
  // before Guacamole.Keyboard's own document-level listener gets a chance
  // to forward the same keystroke into whichever session is focused —
  // without stopPropagation() here, Ctrl+Alt+Arrow would both switch
  // sessions AND get sent to the remote host.
  useEffect(() => {
    const heldLeft = { alt: false, ctrl: false };

    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'AltLeft') heldLeft.alt = true;
      if (e.code === 'ControlLeft') heldLeft.ctrl = true;

      if (heldLeft.alt && heldLeft.ctrl) {
        if (e.code === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          cycle(-1);
        } else if (e.code === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          cycle(1);
        } else if (e.code === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setOverviewOpen(true);
        }
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'AltLeft') heldLeft.alt = false;
      if (e.code === 'ControlLeft') heldLeft.ctrl = false;
    }

    // Also clear the held-state if focus leaves the window entirely (e.g.
    // Alt-Tabbing to another application) — otherwise a stale "held" flag
    // could persist and make the very next Left/Right arrow in this app
    // incorrectly trigger a session switch.
    function onBlur() {
      heldLeft.alt = false;
      heldLeft.ctrl = false;
    }

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Reported directly: signing out landed on a blank page, needing a
  // manual refresh to actually reach the login screen — a real bug,
  // and a real user's own observed workaround (refresh fixes it) is
  // exactly what points at the right fix: a genuine, full page
  // navigation (not React Router's own client-side navigate()) is
  // what a manual refresh effectively does too, and is also, on its
  // own merits, the actually-correct way to sign out regardless of
  // whatever the precise underlying cause of the blank page was —
  // nothing about a signed-out state should carry over any leftover
  // React component state, an open WebSocket tunnel, or anything else
  // still alive from the ended session; a full reload guarantees a
  // completely clean slate the same way it always has, rather than
  // relying on every piece of this app's own client-side state to
  // individually, correctly unwind itself first.
  function signOut() {
    sessionStorage.removeItem('guac.sessionToken');
    window.location.replace('/login');
  }

  const activeSession = openSessions.find((s) => s.key === activeKey) ?? null;

  return (
    <div className="main-app">
      <ShareNotifications apiBase={API_BASE} authToken={authToken} onJoin={joinSession} />
      {showAdhocModal && (
        <AdhocConnectionModal
          apiBase={API_BASE}
          authToken={authToken}
          onClose={() => setShowAdhocModal(false)}
          onConnect={openAdhocConnection}
        />
      )}
      <header className="main-app-header">
        <span className="app-title">Guac Access Suite</span>
        <div className="header-right">
          <button
            className={`view-toggle ${!onManagementRoute && view === 'connections' ? 'is-active' : ''}`}
            onClick={() => goToConnectionsView('connections')}
          >
            {t('header.connections')}
          </button>
          <button
            className={`view-toggle ${!onManagementRoute && view === 'demos' ? 'is-active' : ''}`}
            onClick={() => goToConnectionsView('demos')}
          >
            {t('header.demos')}
          </button>
          {isAdmin && (
            <button className="view-toggle" onClick={() => setShowAdhocModal(true)}>
              {t('header.quickConnect')}
            </button>
          )}
          <div className="session-menu-anchor">
            <button
              className={`admin-link session-menu-trigger ${openSessions.length > 0 ? 'has-sessions' : ''}`}
              onClick={() => setSessionMenuOpen((v) => !v)}
            >
              Sessions{openSessions.length > 0 ? ` (${openSessions.length})` : ''}
            </button>
            {sessionMenuOpen && (
              <SessionMenu
                sessions={openSessions}
                activeKey={activeKey}
                apiBase={API_BASE}
                authToken={authToken}
                onSelect={(key) => {
                  if (onManagementRoute) navigate('/');
                  setActiveKey(key);
                  setSessionMenuOpen(false);
                }}
                onClose={closeSession}
                onDismiss={() => setSessionMenuOpen(false)}
                onOpenOverview={() => {
                  if (onManagementRoute) navigate('/');
                  setOverviewOpen(true);
                  setSessionMenuOpen(false);
                }}
                onJoin={(sessionId, connectionId, protocol, name, readOnly) => {
                  joinSession(sessionId, connectionId, protocol, name, readOnly);
                  setSessionMenuOpen(false);
                }}
              />
            )}
          </div>
          {isAdmin && <Link to="/admin" className="admin-link">{t('header.admin')}</Link>}
          {/* Visible to everyone, not admin-gated — every user has a
              personal connection list, and this is what actually
              reaches full edit/delete/export/import for it now (see
              MyListPage.tsx's own comment for why the admin panel's own
              "Lists" tab can't be that place: it requires admin status
              just to load, and no longer even shows personal lists at
              all as of a recent fix). */}
          <Link to="/my-connections" className="admin-link">{t('header.myConnections')}</Link>
          <ThemePicker />
          <LanguagePicker />
          <button className="admin-link" onClick={() => setHelpOpen(true)}>{t('header.help')}</button>
          <UserMenu apiBase={API_BASE} authToken={authToken} onSignOut={signOut} />
          <VersionBadge />
        </div>
      </header>

      {!onManagementRoute && openSessions.length > 1 && (
        <div className="session-tabs">
          {openSessions.map((s) => (
            <button
              key={s.key}
              className={`session-tab ${s.key === activeKey ? 'is-active' : ''}`}
              onClick={() => setActiveKey(s.key)}
            >
              {s.name}
              <span className="session-tab-close" onClick={(e) => { e.stopPropagation(); closeSession(s.key); }}>
                ×
              </span>
            </button>
          ))}
          <button className="session-tab session-tab-overview" onClick={() => setOverviewOpen(true)} title="Ctrl+Alt+Up">
            ▦
          </button>
        </div>
      )}

      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}

      {overviewOpen && (
        <SessionOverview
          sessions={openSessions}
          activeKey={activeKey}
          onSelect={(key) => { setActiveKey(key); setOverviewOpen(false); }}
          onClose={closeSession}
          onDismiss={() => setOverviewOpen(false)}
        />
      )}

      <main className="main-app-body">
        <Routes>
          <Route
            path="/"
            element={
              view === 'connections' ? (
                <ConnectionPanel
                  apiBase={API_BASE}
                  authToken={authToken}
                  onOpenConnection={openConnection}
                  onVisibilityChange={setPanelOpen}
                />
              ) : (
                <div className="demo-panel-dock" ref={demoPanelDockRef}>
                  <DemoPanel apiBase={API_BASE} authToken={authToken} onOpenConnection={openConnection} />
                </div>
              )
            }
          />
          <Route path="/admin" element={<AdminPanel apiBase={API_BASE} authToken={authToken} isAdmin={isAdmin} />} />
          {/* Nested inside AppShell's own routing, not App.tsx's
              top-level routes — matches /admin exactly, and for the
              identical reason: a top-level route unmounts AppShell
              entirely on navigation, which would destroy every open
              session (the same bug already fixed for /admin a number of
              rounds back — caught here before it shipped, not after). */}
          <Route path="/my-connections" element={<MyListPage />} />
        </Routes>

        {/* Every open session stays mounted (hidden, not unmounted) so its
            WebSocket tunnel stays connected in the background — this now
            holds true across /admin navigation too, not just switching
            between sessions. Only the active one forwards keyboard/mouse
            input (see isActive in SessionViewport.tsx), and the whole
            layer is hidden (still mounted) while /admin is showing so it
            doesn't visually cover the admin UI. Record/Share only render
            for sessions this user opened themselves, not ones they
            joined. */}
        {openSessions.map((s) => (
          <div
            key={s.key}
            data-session-key={s.key}
            className="session-slot"
            style={{ display: !onManagementRoute && s.key === activeKey ? 'block' : 'none' }}
          >
            {!onManagementRoute && s.key === activeKey && !s.isJoin && s.realSessionId && (
              <div className="session-toolbar">
                <RecordButtonStrip sessionId={s.realSessionId} apiBase={API_BASE} authToken={authToken} />
                <ShareSessionButton
                  sessionId={s.realSessionId}
                  apiBase={API_BASE}
                  authToken={authToken}
                  onVisibilityChange={setShareOpen}
                />
                <UnmuteButton />
              </div>
            )}
            <SessionViewport
              connectionId={s.connectionId}
              protocol={s.protocol}
              apiBase={API_BASE}
              authToken={authToken}
              // Real bug found live, reported directly: the exact same
              // keyboard-capture problem already fixed for /admin,
              // ConnectionPanel, the share popover, and the help/overview
              // panels — an active session's Guacamole.Keyboard has no
              // way to know AdhocConnectionModal exists or is currently
              // covering it, so it kept intercepting every keystroke
              // meant for the modal's own hostname/credential fields
              // regardless. showAdhocModal was added to this component's
              // own state without also being added to this same overlay
              // list, the one place every other overlay of this kind
              // already had to be added to for the same reason — an
              // oversight in the original feature, not a new root cause.
              // view !== 'demos' added directly in response to the same
              // bug, a new trigger: DemoPanel (the "Demos" view, its own
              // "create a demo" form among others) is switched to via
              // `view`, which AppShell already tracks directly — unlike
              // panelOpen/shareOpen above, no round-trip callback prop
              // needed here at all, since AppShell doesn't need
              // DemoPanel to tell it something AppShell already, itself,
              // controls.
              isActive={!onManagementRoute && !panelOpen && !helpOpen && !overviewOpen && !shareOpen && !showAdhocModal && view !== 'demos' && s.key === activeKey}
              joinSessionId={s.isJoin ? s.realSessionId ?? undefined : undefined}
              readOnly={s.readOnly}
              adhocSettings={s.adhocSettings}
              onSessionReady={(realSessionId) => setRealSessionId(s.key, realSessionId)}
            />
          </div>
        ))}

        {!onManagementRoute && !activeSession && (
          <div className="no-session-placeholder">Select a connection or demo item to begin.</div>
        )}
      </main>
    </div>
  );
}
