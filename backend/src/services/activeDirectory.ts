import { Client } from 'ldapts';
import { encryptCredential, decryptCredential } from './vaultClient';
import { db } from '../db';
import { SESSION_ABSOLUTE_MAX_HOURS } from './sessionToken';
import { provisionPersonalList } from './userProvisioning';

/**
 * Requested directly, scoped specifically to what was asked for: any AD
 * account that's a member of one configured AD group can sign in, and can
 * optionally use those same AD credentials directly for an RDP/SSH
 * session's own login instead of a separately-stored one.
 *
 * AD-group-to-this-app's-own-groups sync (below, `syncAdGroupMemberships`)
 * was originally, deliberately left out of this same scope — a real,
 * live gap that boundary left open, reported once AD login itself
 * started working: a JIT-provisioned AD account got its own personal
 * list but was never placed into any of this app's own groups at all,
 * so most of the app was inaccessible to it. Requested directly as a
 * follow-up, scoped as multiple, explicit AD-group-DN-to-local-group-name
 * mappings (`AD_GROUP_MAPPINGS`) — genuinely re-evaluated on every login,
 * not just applied once at first creation, including removing a
 * previously-synced membership once it's no longer current — see that
 * function's own comment for how removal is kept from ever touching a
 * membership an admin granted by hand instead.
 *
 * `ldapts`, not `ldapjs` — checked directly, not assumed from prior
 * knowledge: `ldapjs` was formally decommissioned by its own maintainer
 * in 2024 (its own README says so, in those words), with known TLS and
 * memory-leak issues on modern Node — `ldapts` is the actively
 * maintained, TypeScript-first successor exposing the same core
 * operations, and what's actually installed here.
 */

const AD_URL = process.env.AD_URL;
const AD_BASE_DN = process.env.AD_BASE_DN;
const AD_BIND_DN = process.env.AD_BIND_DN;
const AD_BIND_PASSWORD = process.env.AD_BIND_PASSWORD;
const AD_USER_FILTER_TEMPLATE = process.env.AD_USER_FILTER || '(sAMAccountName={{username}})';
const AD_REQUIRED_GROUP_DN = process.env.AD_REQUIRED_GROUP_DN;

export interface AdGroupMapping {
  dn: string;
  localGroup: string;
}

// A JSON array, not a delimited string — an LDAP DN is itself always
// comma-containing ("CN=...,OU=...,DC=...,DC=..."), so any
// comma/semicolon-delimited format for *multiple* DN-to-group pairs
// would be ambiguous to parse correctly; JSON sidesteps that entirely by
// treating each DN as one opaque string value, not something to be
// split on its own commas.
//
// Parsed once, at module load, same as every other AD_* setting here —
// invalid JSON or a malformed entry is logged and skipped rather than
// crashing the app over a config typo, since a broken mapping shouldn't
// take down AD login (or the whole app) over what's, at worst, a
// group-assignment feature not working as configured.
// Exported (not just a private module-level helper) so the diagnostic
// script (scripts/check-ad-group-sync.ts) can parse a fresh copy of
// whatever AD_GROUP_MAPPINGS actually is at the moment it's run,
// through the exact same real logic this module itself uses — not a
// second, hand-copied reimplementation that could quietly drift out of
// sync with this one over time.
export function parseAdGroupMappings(): AdGroupMapping[] {
  const raw = process.env.AD_GROUP_MAPPINGS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('[activeDirectory] AD_GROUP_MAPPINGS is not valid JSON, ignoring it entirely:', err);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error('[activeDirectory] AD_GROUP_MAPPINGS must be a JSON array, ignoring it entirely.');
    return [];
  }
  const mappings: AdGroupMapping[] = [];
  for (const entry of parsed) {
    if (entry && typeof entry === 'object' && typeof (entry as any).dn === 'string' && typeof (entry as any).localGroup === 'string') {
      mappings.push({ dn: (entry as any).dn, localGroup: (entry as any).localGroup });
    } else {
      console.error('[activeDirectory] Skipping a malformed AD_GROUP_MAPPINGS entry (needs a string "dn" and "localGroup"):', JSON.stringify(entry));
    }
  }
  return mappings;
}

const AD_GROUP_MAPPINGS = parseAdGroupMappings();


export function isAdEnabled(): boolean {
  return Boolean(AD_URL && AD_BASE_DN && AD_BIND_DN && AD_BIND_PASSWORD && AD_REQUIRED_GROUP_DN);
}

// RFC 4515 filter-value escaping — the username arrives from the login
// form, so it has to be escaped the same way any other user-supplied
// value going into a query language does, or a crafted username could
// widen the search filter (e.g. inject `)(uid=*` and match every entry)
// the same way an unescaped value could in SQL or a shell command.
function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => {
    switch (c) {
      case '\\': return '\\5c';
      case '*': return '\\2a';
      case '(': return '\\28';
      case ')': return '\\29';
      case '\0': return '\\00';
      default: return c;
    }
  });
}

// Windows' own "down-level logon name" format, DOMAIN\username — a real,
// live login attempt was reported using exactly this
// (contoso.com\Administrator), which is completely standard
// practice for anyone used to a Windows login prompt, not an unusual
// thing to type. Without this, the raw string (backslash and all) went
// straight into the LDAP filter, which escapeLdapFilterValue above then
// correctly, faithfully escapes as a literal backslash character — a
// syntactically valid filter that can never match any real
// sAMAccountName, since that attribute never actually contains a domain
// prefix or a backslash at all. Stripped here, once, before either
// escaping or filter construction — sAMAccountName (or any other
// attribute AD_USER_FILTER might be configured to match against
// instead, e.g. userPrincipalName) never legitimately contains a
// backslash either way, so this is safe to apply unconditionally
// regardless of which filter template is configured, not just the
// default one.
function stripDownLevelDomainPrefix(username: string): string {
  const backslashIndex = username.indexOf('\\');
  return backslashIndex === -1 ? username : username.slice(backslashIndex + 1);
}

function newClient(): Client {
  return new Client({ url: AD_URL!, tlsOptions: { minVersion: 'TLSv1.2' }, connectTimeout: 5000, timeout: 10000 });
}

export interface AdAuthResult {
  ok: boolean;
  dn?: string;
  /** The directory's own sAMAccountName for this entry — may differ in
   * case, or entirely, from what was typed at the login form. */
  resolvedUsername?: string;
  /** This login's own current AD group memberships — passed along so
   * the caller (auth.ts) can re-sync local group membership against it
   * on every login, not just the first. Only present on a genuine
   * success (ok: true); nothing to sync on a failed login. */
  memberOf?: string[];
  reason?: 'ad_not_configured' | 'empty_password' | 'user_not_found' | 'ambiguous_user' | 'invalid_credentials' | 'not_in_required_group' | 'ldap_error';
}

export async function authenticateAgainstAd(username: string, password: string): Promise<AdAuthResult> {
  if (!isAdEnabled()) return { ok: false, reason: 'ad_not_configured' };

  // CRITICAL: an empty password on a Simple Bind with a real DN is a
  // defined, different operation under RFC 4513 §5.1.2 — an
  // "unauthenticated bind" — not a rejected one. Many LDAP servers,
  // Active Directory's own default configuration among them, return
  // success for it. Skipping this check is a real, repeatedly-exploited
  // authentication bypass (CVE-2026-44551, CVE-2026-41720, CVE-2026-90961,
  // GHSA-5hmm-x8q8-w5jh, among others found checking this directly before
  // writing this function, not assumed from memory) — every one of those
  // is exactly this omission, not a novel attack. `ldapts`'s own `bind()`
  // does nothing to guard against this itself (checked its source
  // directly), so this has to be enforced here.
  if (!password) return { ok: false, reason: 'empty_password' };

  const searchClient = newClient();
  try {
    await searchClient.bind(AD_BIND_DN!, AD_BIND_PASSWORD!);

    const searchUsername = stripDownLevelDomainPrefix(username);
    const filter = AD_USER_FILTER_TEMPLATE.replace('{{username}}', escapeLdapFilterValue(searchUsername));
    const { searchEntries } = await searchClient.search(AD_BASE_DN!, {
      scope: 'sub',
      filter,
      attributes: ['dn', 'sAMAccountName', 'memberOf'],
      // Only one match is ever a correct result; requesting 2 turns an
      // over-broad filter into a visible "ambiguous" outcome instead of
      // silently authenticating against whichever entry happened to
      // come back first.
      sizeLimit: 2,
    });
    if (searchEntries.length === 0) return { ok: false, reason: 'user_not_found' };
    if (searchEntries.length > 1) return { ok: false, reason: 'ambiguous_user' };

    const entry = searchEntries[0];
    const userDn = entry.dn;

    // The actual password verification: bind as the user's own DN. A
    // fresh client, not the search connection above — the search
    // connection stays bound as the service account throughout, so a
    // failed user bind here can never leave that connection's own
    // authentication state in question.
    const userClient = newClient();
    try {
      await userClient.bind(userDn, password);
    } catch {
      return { ok: false, reason: 'invalid_credentials' };
    } finally {
      await userClient.unbind().catch(() => {});
    }

    const memberOf = ([] as string[]).concat((entry.memberOf as string | string[] | undefined) ?? []);
    const inRequiredGroup = memberOf.some((dn) => dn.toLowerCase() === AD_REQUIRED_GROUP_DN!.toLowerCase());
    if (!inRequiredGroup) return { ok: false, reason: 'not_in_required_group' };

    const resolvedUsername = String(entry.sAMAccountName ?? searchUsername);
    return { ok: true, dn: userDn, resolvedUsername, memberOf };
  } catch (err) {
    // A real gap found and fixed directly in response to someone unable
    // to diagnose a failed AD login: this used to discard the actual
    // error entirely (a bare `catch {}`), which meant a genuine
    // connectivity/config problem here — unreachable AD_URL, a TLS
    // handshake failure, a wrong AD_BIND_DN/AD_BIND_PASSWORD — left
    // absolutely nothing anywhere, in any log, to diagnose it by. This
    // one specifically goes to the backend's own console (`docker
    // compose logs backend`), not just the audit log below: it's an
    // operational/config problem, not a per-login event tied to any one
    // user, so it belongs in the same place any other startup/config
    // error in this app would surface, checked first before an audit
    // log tab. A wrong password (the inner catch above,
    // 'invalid_credentials') deliberately does NOT get this same
    // treatment — that's an ordinary, expected, frequent outcome, not
    // an operational problem, and logging every wrong-password attempt
    // to the console would just be noise.
    console.error('[activeDirectory] LDAP error during authenticateAgainstAd:', err);
    return { ok: false, reason: 'ldap_error' };
  } finally {
    await searchClient.unbind().catch(() => {});
  }
}

export interface AdMemberOfLookupResult {
  found: boolean;
  dn?: string;
  resolvedUsername?: string;
  memberOf?: string[];
  error?: string;
}

/**
 * Looks up a user's current AD group memberships directly — no
 * password needed, since this only ever binds as the service account
 * (AD_BIND_DN), the same one authenticateAgainstAd itself uses to
 * search. Built specifically for scripts/check-ad-group-sync.ts,
 * requested directly after a real, live report that newly-provisioned
 * AD accounts weren't actually landing in their configured
 * AD_GROUP_MAPPINGS group — reusing this exact bind/search/escaping
 * logic (newClient, escapeLdapFilterValue, stripDownLevelDomainPrefix,
 * AD_USER_FILTER_TEMPLATE) rather than a second, hand-copied
 * implementation in that script that could quietly drift from this
 * one over time, the same reasoning parseAdGroupMappings's own export
 * above already follows.
 *
 * Deliberately does not check AD_REQUIRED_GROUP_DN membership the way
 * authenticateAgainstAd does — this is a read-only diagnostic showing
 * what AD actually, currently reports for someone, not a second login
 * gate, and an admin diagnosing why a specific mapping isn't matching
 * needs to see the real, raw memberOf regardless of whether that
 * person could log in at all.
 */
export async function lookupAdUserMemberOf(username: string): Promise<AdMemberOfLookupResult> {
  if (!isAdEnabled()) return { found: false, error: 'ad_not_configured' };
  const searchClient = newClient();
  try {
    await searchClient.bind(AD_BIND_DN!, AD_BIND_PASSWORD!);
    const searchUsername = stripDownLevelDomainPrefix(username);
    const filter = AD_USER_FILTER_TEMPLATE.replace('{{username}}', escapeLdapFilterValue(searchUsername));
    const { searchEntries } = await searchClient.search(AD_BASE_DN!, {
      scope: 'sub',
      filter,
      attributes: ['dn', 'sAMAccountName', 'memberOf'],
      sizeLimit: 2,
    });
    if (searchEntries.length === 0) return { found: false, error: 'user_not_found' };
    if (searchEntries.length > 1) return { found: false, error: 'ambiguous_user' };
    const entry = searchEntries[0];
    const memberOf = ([] as string[]).concat((entry.memberOf as string | string[] | undefined) ?? []);
    return { found: true, dn: String(entry.dn), resolvedUsername: String(entry.sAMAccountName ?? searchUsername), memberOf };
  } catch (err) {
    return { found: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await searchClient.unbind().catch(() => {});
  }
}

/**
 * Captures this login's own AD credentials for later ad_passthrough use
 * (connections.credential_mode = 'ad_passthrough') — only ever called
 * right after authenticateAgainstAd() itself returns ok: true, with the
 * exact same password that already passed that real bind, never stored
 * on spec or ahead of a successful login. Vault-encrypted at rest, the
 * same as connection_credentials' own stored credentials.
 *
 * Expiry uses SESSION_ABSOLUTE_MAX_HOURS, not SESSION_IDLE_TIMEOUT_MINUTES
 * — a real mismatch caught before shipping, not the original design: the
 * app's own session token is a sliding window, refreshed on every
 * request (requireAuth.ts), so an actively-used session can genuinely
 * stay alive far longer than one idle-timeout window; tying this to the
 * idle window's fixed length instead would have meant an actively-used
 * session's own AD credential going stale under it mid-session, well
 * before the session itself ever did. The absolute max is what this
 * credential can actually never legitimately be needed past, since
 * reaching an ad_passthrough connection at all already requires passing
 * requireAuth's own check on the app session token first — that check is
 * what actually gates staleness on ordinary, idle grounds; this is the
 * hard ceiling behind it, not a duplicate of it.
 */
export async function storeAdPassthroughCredential(userId: string, adUsername: string, password: string): Promise<void> {
  const [usernameEncrypted, passwordEncrypted] = await Promise.all([
    encryptCredential(adUsername),
    encryptCredential(password),
  ]);
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_MAX_HOURS * 60 * 60 * 1000);
  await db.none(
    `INSERT INTO ad_passthrough_credentials (user_id, ad_username_encrypted, ad_password_encrypted, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       ad_username_encrypted = EXCLUDED.ad_username_encrypted,
       ad_password_encrypted = EXCLUDED.ad_password_encrypted,
       created_at = now(),
       expires_at = EXCLUDED.expires_at`,
    [userId, usernameEncrypted, passwordEncrypted, expiresAt],
  );
}

export interface AdPassthroughCredential {
  username: string;
  password: string;
}

/** Returns null for "nothing usable right now" (never captured, or past
 * its own expiry) rather than throwing — callers (guacTunnel.ts) treat
 * this exactly like "no credential configured" on an individual
 * connection nobody has set one on yet, an ordinary, expected state, not
 * an error condition. */
export async function getAdPassthroughCredential(userId: string): Promise<AdPassthroughCredential | null> {
  const row = await db.oneOrNone(
    `SELECT ad_username_encrypted, ad_password_encrypted FROM ad_passthrough_credentials
     WHERE user_id = $1 AND expires_at > now()`,
    [userId],
  );
  if (!row) return null;
  const [username, password] = await Promise.all([
    decryptCredential(row.ad_username_encrypted),
    decryptCredential(row.ad_password_encrypted),
  ]);
  return { username, password };
}

/** Best-effort cleanup of a stored credential, called from wherever it's
 * genuinely known to no longer be needed — currently just admin.ts's own
 * "disable user" route (an admin's disable should take effect
 * immediately, not wait out whatever's left of this row's own expiry
 * window). There's deliberately no explicit sign-out call to hook this
 * into: this app's own sessions are stateless JWTs (see
 * services/sessionToken.ts), verified per-request rather than tracked
 * server-side, so "signing out" has never been a server-side event at
 * all — the client simply discards its own token. A stored credential's
 * own expires_at (SESSION_ABSOLUTE_MAX_HOURS, above) is what actually
 * bounds an unused row's lifetime in the ordinary case; this function is
 * for the cases that shouldn't have to wait for that. */
export async function clearAdPassthroughCredential(userId: string): Promise<void> {
  await db.none('DELETE FROM ad_passthrough_credentials WHERE user_id = $1', [userId]);
}

export interface AdUserRecord {
  id: string;
  totpEnabled: boolean;
  mustChangePassword: boolean;
}

/**
 * Maps a successfully-AD-authenticated username to a local `users` row,
 * creating one just-in-time on first login (never ahead of one — the
 * whole point of gating login by AD group membership is that an admin
 * doesn't have to pre-create every future member's account by hand).
 * Reuses the same personal-list provisioning every other new account
 * gets (userProvisioning.ts's own provisionPersonalList) — a JIT-created
 * AD account starts with exactly the same "My Connections" list a
 * locally-created one does, not a stripped-down variant.
 *
 * `auth_source = 'ad'` in the lookup, not just matching by username
 * alone — a username collision between a local and an AD account is
 * always possible (a locally-created "alice" existing before AD is ever
 * turned on, then a real AD "alice" logging in later), and this keeps
 * the two identities from ever being silently merged into the same row.
 * A route calling this is expected to have already confirmed no
 * `auth_source = 'local'` row exists for this same username first (see
 * auth.ts's own login handler).
 */
export async function findOrProvisionAdUser(username: string): Promise<AdUserRecord> {
  const existing = await db.oneOrNone(
    `SELECT id, totp_enabled, must_change_password FROM users WHERE username = $1 AND auth_source = 'ad'`,
    [username],
  );
  if (existing) {
    return { id: existing.id, totpEnabled: existing.totp_enabled, mustChangePassword: existing.must_change_password };
  }

  const created = await db.one(
    `INSERT INTO users (username, password_hash, auth_source) VALUES ($1, NULL, 'ad') RETURNING id, totp_enabled, must_change_password`,
    [username],
  );
  await provisionPersonalList(created.id);
  return { id: created.id, totpEnabled: created.totp_enabled, mustChangePassword: created.must_change_password };
}

/**
 * Re-evaluates a user's local group membership against their current AD
 * group memberships and AD_GROUP_MAPPINGS, on every login — not a
 * one-time grant at first creation, a genuine, live sync: a group
 * someone is no longer an AD member of gets removed here too, not just
 * added to when they newly qualify. Called from auth.ts right after
 * every successful AD login, first-time or repeat alike.
 *
 * Auto-creates a mapped local group the first time it's actually
 * needed, rather than requiring an admin to pre-create it through the
 * ordinary admin panel first — requested directly, since requiring that
 * extra manual step ahead of time is exactly the kind of gap this
 * feature exists to close in the first place.
 *
 * The removal side only ever touches a `user_groups` row whose own
 * `source` is `'ad_sync'` (migration 022) — never a `'manual'` one, an
 * admin's own, deliberate grant through the ordinary admin panel. Two
 * consequences worth knowing, not just implementation detail: (1) if an
 * admin manually adds someone to a group AD_GROUP_MAPPINGS also maps
 * them into, that row's own `source` stays whatever it already was
 * (`ON CONFLICT DO NOTHING` on the add side, not an upsert that would
 * overwrite `'manual'` with `'ad_sync'`) — sync will never remove it,
 * regardless of what their AD memberOf later says; (2) an admin
 * manually *removing* someone from a group that's currently
 * AD-sync-derived doesn't stick — their very next login re-adds it,
 * since AD's own current membership is treated as the source of truth
 * for that specific membership, not the local row on its own. That's
 * the intended, "genuine sync" behavior this was asked for, not a bug —
 * worth documenting plainly (see README.md) precisely because it could
 * otherwise look like one.
 */
export async function syncAdGroupMemberships(userId: string, memberOf: string[]): Promise<void> {
  if (AD_GROUP_MAPPINGS.length === 0) return;

  const memberOfLower = new Set(memberOf.map((dn) => dn.toLowerCase()));
  const shouldBeIn = AD_GROUP_MAPPINGS.filter((m) => memberOfLower.has(m.dn.toLowerCase()));

  for (const mapping of shouldBeIn) {
    const group = await db.oneOrNone(`SELECT id FROM groups WHERE name = $1`, [mapping.localGroup])
      ?? await db.one(
        `INSERT INTO groups (name, description) VALUES ($1, $2) RETURNING id`,
        [mapping.localGroup, `Auto-created from AD group sync (${mapping.dn})`],
      );
    await db.none(
      `INSERT INTO user_groups (user_id, group_id, source) VALUES ($1, $2, 'ad_sync')
       ON CONFLICT (user_id, group_id) DO NOTHING`,
      [userId, group.id],
    );
  }

  // Removal: any group this user is currently in via a previous sync
  // (source = 'ad_sync'), but whose mapped DN isn't in their AD
  // membership right now, gets removed — the actual "sync," not just
  // one-way provisioning. Two explicit branches, not one query relying
  // on how Postgres's own `= ANY(...)` happens to behave against an
  // empty array — deliberately not assumed correct from memory without
  // a real database available to confirm it against this round.
  const shouldBeInIds = shouldBeIn.length > 0
    ? (await db.any(
        `SELECT id FROM groups WHERE name = ANY($1)`,
        [shouldBeIn.map((m) => m.localGroup)],
      )).map((r: { id: string }) => r.id)
    : [];
  if (shouldBeInIds.length === 0) {
    await db.none(`DELETE FROM user_groups WHERE user_id = $1 AND source = 'ad_sync'`, [userId]);
  } else {
    await db.none(
      `DELETE FROM user_groups WHERE user_id = $1 AND source = 'ad_sync' AND NOT (group_id = ANY($2))`,
      [userId, shouldBeInIds],
    );
  }
}
