import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getEffectiveListPermission, requireListPermission, hasBookmarkAccess } from '../services/permissions';
import { db } from '../db';
import { issueProxySessionCookie } from '../services/bookmarkProxy';
import { logAuditFromRequest } from '../services/auditLog';

export const bookmarksRouter = Router();

// Session issuance is authenticated (unlike the proxy traffic itself), so
// this can be keyed more tightly than the general proxy rate limit — a
// legitimate user opens a given bookmark rarely, not dozens of times a
// minute.
const proxySessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

// Issues the path-scoped auth cookie for a 'proxied' bookmark, then hands
// back the URL to open. Called right before window.open() in the frontend —
// the cookie has to already be set by the time the new tab's first request
// hits /proxy/:bookmarkId, so this must be a same-tab fetch, not the
// navigation itself.
bookmarksRouter.post('/:id/proxy-session', proxySessionLimiter, async (req, res) => {
  const bookmark = await db.oneOrNone(`SELECT list_id, access_mode FROM bookmarks WHERE id = $1`, [req.params.id]);
  if (!bookmark) return res.status(404).json({ error: 'not_found' });
  if (bookmark.access_mode !== 'proxied') return res.status(400).json({ error: 'not_a_proxied_bookmark' });

  const allowed = await hasBookmarkAccess(req.userId!, req.params.id, 'view');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  issueProxySessionCookie(req, res, req.params.id, req.userId!);
  res.json({ openUrl: `/proxy/${req.params.id}/` });
});

bookmarksRouter.get('/lists/:listId', async (req, res) => {
  const allowed = await getEffectiveListPermission(req.userId!, req.params.listId);
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const bookmarks = await db.any(
    `SELECT b.id, b.name, b.url, b.description, b.icon_url, b.access_mode, b.enable_websocket, b.folder_id
     FROM bookmarks b
     LEFT JOIN bookmark_folders f ON f.id = b.folder_id
     WHERE b.list_id = $1 ORDER BY f.name NULLS FIRST, b.name`,
    [req.params.listId]
  );
  res.json({ permission: allowed, bookmarks });
});

bookmarksRouter.post('/lists/:listId', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name, url, description, iconUrl, accessMode, enableWebsocket, folderId } = req.body;
  if (!isValidHttpUrl(url)) return res.status(400).json({ error: 'invalid_url' });

  const bookmark = await db.one(
    `INSERT INTO bookmarks (list_id, name, url, description, icon_url, access_mode, enable_websocket, folder_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      req.params.listId,
      name,
      url,
      description ?? '',
      iconUrl ?? null,
      accessMode === 'proxied' ? 'proxied' : 'direct',
      !!enableWebsocket,
      // Real bug found live: `??` only falls back on null/undefined,
      // not an empty string — and a <select> defaulting to "No folder"
      // naturally submits folderId as '', not null. That empty string
      // went straight into folder_id, a UUID column, which Postgres
      // rejects outright with a type error — a 500, shown to the user
      // as a generic, unexplained "could not save" with no indication a
      // folder was ever involved. Same fix applied to every one of the
      // five other sites with this identical pattern (see admin.ts's
      // own connection create/update/folder-assignment routes).
      folderId || null
    ]
  );
  await logAuditFromRequest(req, 'bookmark_created', { listId: req.params.listId, name, url, accessMode: accessMode === 'proxied' ? 'proxied' : 'direct' });
  res.json({ id: bookmark.id });
});

bookmarksRouter.put('/:id', async (req, res) => {
  const bookmark = await db.one(`SELECT list_id FROM bookmarks WHERE id = $1`, [req.params.id]);
  const allowed = await requireListPermission(req.userId!, bookmark.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name, url, description, iconUrl, accessMode, enableWebsocket, folderId } = req.body;
  if (url && !isValidHttpUrl(url)) return res.status(400).json({ error: 'invalid_url' });

  await db.none(
    `UPDATE bookmarks SET name = $1, url = $2, description = $3, icon_url = $4,
       access_mode = $5, enable_websocket = $6, folder_id = $7, updated_at = now()
     WHERE id = $8`,
    [
      name,
      url,
      description ?? '',
      iconUrl ?? null,
      accessMode === 'proxied' ? 'proxied' : 'direct',
      !!enableWebsocket,
      folderId || null,
      req.params.id
    ]
  );
  await logAuditFromRequest(req, 'bookmark_updated', { bookmarkId: req.params.id, name, url });
  res.json({ status: 'updated' });
});

// A dedicated, minimal endpoint for assigning a bookmark to a folder from
// a dropdown, mirroring the identical fix made for connections
// (PATCH /api/admin/connections/:id/folder) and for the same reason:
// PUT /:id above overwrites the entire row. A "quick folder assignment"
// going through it would risk silently clobbering other fields (e.g.
// description, enable_websocket) whenever the caller doesn't already have
// every current value in hand — this only ever touches folder_id.
bookmarksRouter.patch('/:id/folder', async (req, res) => {
  const bookmark = await db.oneOrNone(`SELECT list_id FROM bookmarks WHERE id = $1`, [req.params.id]);
  if (!bookmark) return res.status(404).json({ error: 'not_found' });
  const allowed = await requireListPermission(req.userId!, bookmark.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { folderId } = req.body;
  await db.none(`UPDATE bookmarks SET folder_id = $1, updated_at = now() WHERE id = $2`, [folderId || null, req.params.id]);
  await logAuditFromRequest(req, 'bookmark_folder_changed', { bookmarkId: req.params.id, folderId: folderId || null });
  res.json({ status: 'updated' });
});

// Real, standalone folder entities for bookmarks — mirrors
// connection_folders and its admin.ts routes exactly (see migration
// 019's own comment for why this is a separate table rather than a
// shared one).
bookmarksRouter.get('/lists/:listId/folders', async (req, res) => {
  const allowed = await getEffectiveListPermission(req.userId!, req.params.listId);
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const folders = await db.any(`SELECT id, name FROM bookmark_folders WHERE list_id = $1 ORDER BY name`, [req.params.listId]);
  res.json({ folders });
});

bookmarksRouter.post('/lists/:listId/folders', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'invalid_input', message: 'name is required.' });
  }
  try {
    const folder = await db.one(
      `INSERT INTO bookmark_folders (list_id, name) VALUES ($1, $2) RETURNING id, name`,
      [req.params.listId, String(name).trim()]
    );
    await logAuditFromRequest(req, 'bookmark_folder_created', { listId: req.params.listId, name: folder.name });
    res.json(folder);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'folder_already_exists' });
    throw err;
  }
});

bookmarksRouter.put('/folders/:id', async (req, res) => {
  const folder = await db.oneOrNone(`SELECT list_id FROM bookmark_folders WHERE id = $1`, [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'not_found' });
  const allowed = await requireListPermission(req.userId!, folder.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'invalid_input', message: 'name is required.' });
  }
  try {
    await db.none(`UPDATE bookmark_folders SET name = $1 WHERE id = $2`, [String(name).trim(), req.params.id]);
    await logAuditFromRequest(req, 'bookmark_folder_renamed', { folderId: req.params.id, name: String(name).trim() });
    res.json({ status: 'updated' });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'folder_already_exists' });
    throw err;
  }
});

bookmarksRouter.delete('/folders/:id', async (req, res) => {
  const folder = await db.oneOrNone(`SELECT list_id FROM bookmark_folders WHERE id = $1`, [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'not_found' });
  const allowed = await requireListPermission(req.userId!, folder.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  // ON DELETE SET NULL on bookmarks.folder_id (migration 019) — every
  // bookmark in this folder moves back to the top level, not deleted
  // along with the folder. Verified directly against a real running
  // Postgres instance for the identical connections version of this;
  // same schema pattern here.
  await db.none(`DELETE FROM bookmark_folders WHERE id = $1`, [req.params.id]);
  await logAuditFromRequest(req, 'bookmark_folder_deleted', { folderId: req.params.id });
  res.json({ status: 'deleted' });
});

bookmarksRouter.delete('/:id', async (req, res) => {
  const bookmark = await db.one(`SELECT list_id FROM bookmarks WHERE id = $1`, [req.params.id]);
  const allowed = await requireListPermission(req.userId!, bookmark.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  await db.none(`DELETE FROM bookmarks WHERE id = $1`, [req.params.id]);
  await logAuditFromRequest(req, 'bookmark_deleted', { bookmarkId: req.params.id });
  res.json({ status: 'deleted' });
});

// --- Export: internal JSON (same schema_version pattern as connection lists) ---
bookmarksRouter.get('/lists/:listId/export', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'view');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const list = await db.one(`SELECT name, description FROM connection_lists WHERE id = $1`, [req.params.listId]);
  const bookmarks = await db.any(
    `SELECT name, url, description, icon_url, access_mode, enable_websocket FROM bookmarks WHERE list_id = $1`,
    [req.params.listId]
  );

  res.json({
    schema_version: 1,
    list_name: list.name,
    description: list.description,
    exported_at: new Date().toISOString(),
    bookmarks
  });
});

// --- Export: Netscape Bookmark File Format (importable by Chrome, Firefox, Edge, Safari) ---
bookmarksRouter.get('/lists/:listId/export-html', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'view');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const list = await db.one(`SELECT name FROM connection_lists WHERE id = $1`, [req.params.listId]);
  // Proxied bookmarks point at hosts only this app's backend can reach —
  // exporting them into a real browser's bookmarks would just produce dead
  // links, so only 'direct' bookmarks are included here.
  const bookmarks = await db.any(
    `SELECT name, url FROM bookmarks WHERE list_id = $1 AND access_mode = 'direct' ORDER BY name`,
    [req.params.listId]
  );

  const html = buildNetscapeBookmarkHtml(list.name, bookmarks);

  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${sanitizeFilename(list.name)}-bookmarks.html"`
  );
  res.send(html);
});

function buildNetscapeBookmarkHtml(folderName: string, bookmarks: { name: string; url: string }[]): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const items = bookmarks
    .map((b) => `        <DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${nowSeconds}">${escapeHtml(b.name)}</A>`)
    .join('\n');

  // This exact structure (DOCTYPE + nested <DL><p> folder) is what Chrome's
  // "Bookmarks > Import bookmarks" and Firefox's "Import Bookmarks from HTML"
  // both expect — deviating from it (e.g. valid XHTML nesting) causes some
  // browsers to silently import zero bookmarks.
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${nowSeconds}">${escapeHtml(folderName)}</H3>
    <DL><p>
${items}
    </DL><p>
</DL><p>
`;
}

// --- Import: internal JSON ---
bookmarksRouter.post('/lists/:listId/import', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { schema_version, bookmarks } = req.body;
  if (schema_version !== 1) return res.status(400).json({ error: 'unsupported_schema_version' });

  let imported = 0;
  for (const b of bookmarks) {
    if (!isValidHttpUrl(b.url)) continue; // skip malformed entries rather than failing the whole import
    await db.none(
      `INSERT INTO bookmarks (list_id, name, url, description, access_mode, enable_websocket) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.params.listId,
        b.name,
        b.url,
        b.description ?? '',
        b.access_mode === 'proxied' ? 'proxied' : 'direct',
        !!b.enable_websocket
      ]
    );
    imported++;
  }
  await logAuditFromRequest(req, 'bookmarks_imported_json', { listId: req.params.listId, imported });
  res.json({ imported, skipped: bookmarks.length - imported });
});

// --- Import: a Netscape bookmark HTML file exported from a real browser ---
// Accepts raw HTML in the request body (frontend reads the uploaded .html
// file as text and posts it here) — lets a user bring in their existing
// Chrome/Firefox bookmarks bar as a connection-list bookmark set.
bookmarksRouter.post('/lists/:listId/import-html', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { html } = req.body;
  const parsed = parseNetscapeBookmarkHtml(html);

  let imported = 0;
  for (const b of parsed) {
    if (!isValidHttpUrl(b.url)) continue;
    await db.none(
      `INSERT INTO bookmarks (list_id, name, url) VALUES ($1, $2, $3)`,
      [req.params.listId, b.name, b.url]
    );
    imported++;
  }
  await logAuditFromRequest(req, 'bookmarks_imported_html', { listId: req.params.listId, imported });
  res.json({ imported, skipped: parsed.length - imported });
});

function parseNetscapeBookmarkHtml(html: string): { name: string; url: string }[] {
  const results: { name: string; url: string }[] = [];
  const linkPattern = /<A[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    results.push({ url: decodeHtmlEntities(match[1]), name: decodeHtmlEntities(match[2]) });
  }
  return results;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9\-_]+/gi, '-').toLowerCase();
}
