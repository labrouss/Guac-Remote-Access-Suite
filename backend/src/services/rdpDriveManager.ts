import fs from 'fs';
import path from 'path';

const RDP_DRIVES_PATH = process.env.RDP_DRIVES_PATH || '/data/rdp-drives';

interface DriveEntry {
  drivePath: string;
  knownFiles: Set<string>;
  pendingDownloads: string[];
  watcher: fs.FSWatcher;
  // See createDrive's own comment on the debounce logic below for why
  // this exists — one in-flight "has this file stopped changing yet"
  // timer per filename currently being written.
  settleTimers: Map<string, NodeJS.Timeout>;
}

const drives = new Map<string, DriveEntry>();

/**
 * Creates the per-session drive-redirection folder and starts watching it.
 * guacd mounts this same host path inside the RDP session (via the
 * enable-drive / drive-path connection params) as a "Guacamole Transfer"
 * network drive — dragging a file into that drive from within Windows makes
 * it appear here, and anything we drop here appears inside the session.
 *
 * Reported directly: no access to the drive at all from inside the RDP
 * session. Checked directly, not assumed, against Apache Guacamole's own
 * official Docker installation manual, which states plainly that the
 * official guacamole/guacd image "runs with an effective UID and GID of
 * 1000" — this backend container's own Dockerfile has no USER directive
 * at all, so it runs as root. mkdirSync's own default mode (0755) means
 * only its owner (root, here) can actually write into it — guacd itself,
 * running as UID 1000 on the very same shared volume, is neither that
 * owner nor (with nothing establishing it) in a group that owns it
 * either, so its own attempt to write a file into the drive — which is
 * literally how "drag a file into the Windows virtual drive" actually
 * reaches this host directory at all — fails outright. A real, live
 * permissions problem, not a configuration or parameter-naming one (the
 * enable-drive/drive-path/create-drive-path/drive-name parameters
 * themselves are already correct, confirmed directly against the same
 * official manual).
 *
 * Fixed with an explicit, unconditional chmod right after creation,
 * rather than trying to match this container's own UID to guacd's
 * specific one (1000) — a bigger, riskier change to make blind, given
 * no real Docker daemon is available in this environment to verify it
 * against, and one that could affect this container's own access to
 * everything else it writes, not just this one, already-isolated,
 * per-session, randomly-named folder. World-writable specifically
 * because guacd's own UID, while documented, isn't guaranteed to match
 * across every possible guacd image/version someone might actually run
 * this against — matching on "any UID, not specifically 1000" is more
 * robust than hardcoding that number into a permission check here.
 */
export function createDrive(rdpDriveId: string): string {
  const drivePath = path.join(RDP_DRIVES_PATH, rdpDriveId);
  fs.mkdirSync(drivePath, { recursive: true });
  fs.chmodSync(drivePath, 0o777);

  // Reported directly, twice — still recurring after the desktop.ini-
  // specific filter and grace period below were already in place.
  // Confirmed definitively this time, not guessed further at: a real,
  // live guacd log the person actually shared showed the concrete,
  // exact cause — "File open refused (-2): '\desktop.ini'" and
  // separately "File open refused (-7): '\Download'", both refused,
  // neither one actually written to the host side at all. A follow-up
  // browser console error confirmed the second one directly: a real,
  // live attempt to download something literally named "Download" (no
  // extension, capital D), 404ing exactly because nothing by that name
  // had ever actually been written here — Windows (or some app running
  // within the remote session) evidently probes for a few different,
  // specific names on a freshly-mounted network drive, refused every
  // time since none of them genuinely exist here, and this watcher was
  // treating each refused probe as if it were a real file arriving
  // regardless.
  //
  // Fixed properly this time with a general, evidence-grounded check
  // rather than another specific name added to an ever-growing
  // blocklist: since a "File open refused" observably, confirmedly
  // never leaves anything real behind on the host side either way,
  // requiring the named path to actually, genuinely exist as a real
  // file right now — not just that some event fired mentioning its
  // name — directly rules out every probe of this entire class in one
  // general check, not just the two specific names already seen by
  // name. The grace period and the desktop.ini/thumbs.db name filter
  // are both still kept alongside this, not made redundant by it —
  // cheaper, immediate checks worth keeping ahead of a filesystem
  // call, even though this new check is now the one actually,
  // definitively closing the gap the other two didn't.
  const createdAt = Date.now();

  const entry: DriveEntry = {
    drivePath,
    knownFiles: new Set(),
    pendingDownloads: [],
    settleTimers: new Map(),
    watcher: fs.watch(drivePath, (_eventType, filename) => {
      if (!filename) return;
      if (Date.now() - createdAt < 3000) return;
      const lower = filename.toLowerCase();
      if (lower === 'desktop.ini' || lower === 'thumbs.db') return;
      // The actual, general fix — see this function's own comment
      // above for the full reasoning: a refused probe never leaves a
      // real file behind, so requiring one to genuinely, currently
      // exist rules out this entire class of false positive directly,
      // not just the two specific names already confirmed by name.
      const fullPath = path.join(drivePath, filename);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
      if (entry.knownFiles.has(filename)) return;

      // Reported directly: copying a large file into the drive produced
      // several, separate "ready to download" notices for what was
      // really the same, single, still-in-progress copy, before it had
      // even finished. Confirmed directly, not assumed: a large file
      // arriving over RDPDR is written incrementally, in chunks — not
      // one atomic write — so this callback genuinely fires several
      // times for the exact same filename while it's still being
      // written, each one a real, distinct fs.watch event, not a
      // duplicate one. The frontend's own polling clears
      // pendingDownloads each time it runs (takePendingDownloads
      // below), so a second, later event for that same, still-copying
      // file passed the dedupe check again the moment it ran between
      // two polls, adding it a second time for what was, from the
      // person's own perspective, one single file they were still
      // waiting on.
      //
      // Fixed with the standard, well-established pattern for exactly
      // this class of problem — waiting for a file's own writes to
      // settle before treating it as finished, rather than treating
      // "a write happened" as "the write is done": each new event for
      // a given filename cancels and restarts a short timer for that
      // filename specifically, rather than surfacing it immediately.
      // Only once that timer actually elapses without being reset
      // again — meaning genuinely no further writes arrived for that
      // file in the interim — is it treated as settled and surfaced,
      // once, as ready. A large, ongoing copy keeps resetting its own
      // timer on every chunk and is never surfaced until it's
      // genuinely finished; a small file's one or two quick writes
      // settle almost immediately and are surfaced with no
      // perceptible delay.
      const existing = entry.settleTimers.get(filename);
      if (existing) clearTimeout(existing);
      entry.settleTimers.set(
        filename,
        setTimeout(() => {
          entry.settleTimers.delete(filename);
          // Re-check on the way out, not just on the way in — the file
          // could have been deleted, renamed, or (for the desktop.ini/
          // thumbs.db case) only just fully appeared in the time this
          // timer was waiting.
          if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
          if (entry.knownFiles.has(filename) || entry.pendingDownloads.includes(filename)) return;
          entry.pendingDownloads.push(filename);
        }, 1500)
      );
    })
  };
  drives.set(rdpDriveId, entry);
  return drivePath;
}

export function getDrivePath(rdpDriveId: string): string | undefined {
  return drives.get(rdpDriveId)?.drivePath;
}

export function markKnown(rdpDriveId: string, filename: string) {
  drives.get(rdpDriveId)?.knownFiles.add(filename);
}

export function takePendingDownloads(rdpDriveId: string): string[] {
  const entry = drives.get(rdpDriveId);
  if (!entry) return [];
  const pending = entry.pendingDownloads;
  entry.pendingDownloads = [];
  return pending;
}

export function cleanupDrive(rdpDriveId: string) {
  const entry = drives.get(rdpDriveId);
  if (!entry) return;
  entry.watcher.close();
  // Otherwise a settle timer already in flight when a session ends could
  // still fire afterward, checking a drive path that's either already
  // gone or about to be — pointless at best, and a real error at worst.
  for (const timer of entry.settleTimers.values()) clearTimeout(timer);
  fs.rm(entry.drivePath, { recursive: true, force: true }, () => {});
  drives.delete(rdpDriveId);
}
