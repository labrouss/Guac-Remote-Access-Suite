import { db } from '../db';
import { clearAdPassthroughCredential } from './activeDirectory';

/**
 * A real, distinct need from the existing "disable" feature (which
 * only ever sets disabled_at — the row, and everything tied to it,
 * stays exactly as it was) — requested directly, as the actual
 * removal disable was never meant to be.
 *
 * The real design problem this raised, worked through directly rather
 * than assumed: several tables reference users(id) with no ON DELETE
 * clause at all (defaulting to RESTRICT), which would make a plain
 * `DELETE FROM users` fail outright for almost any real account —
 * a single login already writes an audit_log row. Migration 023 fixes
 * the schema itself (SET NULL rather than RESTRICT or a wholesale
 * CASCADE, preserving audit-relevant history and anything shared with
 * other people rather than destroying it); everything below is the
 * handful of steps that schema alone can't express on its own:
 *
 * 1. Snapshot the username onto this account's own past audit_log rows
 *    (audit_log.removed_user_username, migration 023) before the
 *    row disappears and user_id there goes to NULL — otherwise the
 *    human-readable "who" is lost from the audit trail entirely, not
 *    just the live account reference, which would meaningfully weaken
 *    exactly the record that column exists to keep.
 * 2. Explicitly delete this account's own personal list
 *    (is_personal = true) — the one piece of owned content genuinely,
 *    exclusively private to this one account; ON DELETE CASCADE on
 *    connections/connection_credentials takes care of everything
 *    inside it once the list row itself goes. A *shared* list this
 *    account happened to own is deliberately left alone — migration
 *    002's own connection_lists.owner_id is already ON DELETE SET
 *    NULL, not something this needs to touch, since other people may
 *    still depend on that list.
 * 3. Clear any cached AD passthrough credential, the same reasoning as
 *    the existing disable route's own identical step (and run in the
 *    same order: the database change first, then this) — though
 *    migration 021's own ON DELETE CASCADE on that table would remove
 *    it anyway once the user row goes, doing it explicitly here means
 *    it's gone from Vault right away rather than only implicitly,
 *    incidentally cleaned up as a side effect of something else.
 * 4. Delete the user row itself — every other table (user_groups,
 *    webauthn_credentials, individual-mode connection_credentials,
 *    themes, list_user_permissions, session_shares.granted_to_user_id)
 *    is already correctly CASCADE or SET NULL from its own original
 *    migration, nothing further needed here.
 *
 * All four run in one transaction — not because any one step is likely
 * to fail on its own, but because a partial removal (audit rows
 * snapshotted, personal list gone, yet the account itself somehow
 * still there) would be a genuinely confusing, hard-to-recover state
 * to leave behind.
 *
 * What this does NOT do, worth being explicit about rather than
 * silently incomplete: this app issues stateless JWTs, and
 * middleware/requireAuth.ts verifies a token's own signature and
 * expiry only — it never re-checks the database on each request, for
 * this or for the existing disable feature either. An account with an
 * already-issued, still-unexpired token keeps authenticating even
 * after this runs, for up to SESSION_ABSOLUTE_MAX_HOURS — the exact
 * same limitation disable already has today, not something newly
 * introduced here. In practice most routes do their own separate
 * permission lookups against the now-gone user_id and would find
 * nothing to match, but that's an incidental effect of those checks,
 * not a deliberate revocation of the token itself. Actually closing
 * this would mean adding some form of server-side session tracking —
 * a real, separate architectural decision, not something to fold in
 * silently as a side effect of a remove-user button; flagged plainly
 * in TODO.md instead.
 */
export async function removeUser(userId: string): Promise<void> {
  await db.tx(async (t) => {
    const user = await t.oneOrNone(`SELECT username FROM users WHERE id = $1`, [userId]);
    if (!user) return; // already gone — nothing further to do, not an error
    await t.none(
      `UPDATE audit_log SET removed_user_username = $2, user_id = NULL WHERE user_id = $1`,
      [userId, user.username],
    );
    await t.none(`DELETE FROM connection_lists WHERE owner_id = $1 AND is_personal = true`, [userId]);
    await t.none(`DELETE FROM users WHERE id = $1`, [userId]);
  });
  // Same order as the existing disable route: the database change
  // first, Vault cleanup after — and Vault itself isn't part of the
  // Postgres transaction above at all (it's a separate service, not
  // something a Postgres transaction could ever meaningfully wrap),
  // so this can only ever run as its own, separate step regardless.
  await clearAdPassthroughCredential(userId);
}
