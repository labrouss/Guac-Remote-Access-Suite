import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db';

export const versionRouter = Router();

// Reads the VERSION file baked into the image at build time (COPY VERSION /app/VERSION)
// so the running instance always reports exactly what was deployed.
//
// ../../../VERSION, not ../../VERSION — the same class of bug this
// project already hit once with server.ts's own compiled path
// (backend/Dockerfile's CMD). This file's source lives at
// src/routes/version.ts, but tsconfig.json's rootDir "." preserves the
// src/ prefix in the compiled output, so the real runtime path is
// dist/src/routes/version.js — __dirname is dist/src/routes, three
// levels below /app, not two. The old path silently always missed
// (looking for dist/VERSION, which never existed) and fell into the
// catch block every single time, which is why the version badge always
// showed "unknown" rather than a real version number — confirmed live.
versionRouter.get('/', async (_req, res) => {
  let version: string;
  try {
    version = fs.readFileSync(path.join(__dirname, '../../../VERSION'), 'utf8').trim();
  } catch {
    version = 'unknown';
  }

  // instanceName was set during setup (routes/setup.ts) but never
  // actually exposed anywhere for the running app to read back —
  // requested live: the app shell's corner showed only "vunknown" with
  // nothing identifying which instance you're looking at, which matters
  // once someone's managing more than one deployment. Bundled onto this
  // same endpoint rather than a new one, since the frontend already
  // fetches this on every load for the version number anyway.
  const config = await db.oneOrNone(`SELECT instance_name FROM system_config WHERE id = true`);
  res.json({ version, instanceName: config?.instance_name ?? null });
});
