import { Router } from 'express';
import { db } from '../db';

export const usersRouter = Router();

// Available to any authenticated user, not just admins — granting demo
// access or list permissions to someone by name is something any user with
// edit rights on their own list/demo needs to do, not just instance admins.
// Capped at 20 results and requires at least 2 characters so this can't be
// used to enumerate the entire user table one keystroke at a time.
usersRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json([]);

  const users = await db.any(
    `SELECT id, username FROM users
     WHERE username ILIKE $1 AND disabled_at IS NULL
     ORDER BY username LIMIT 20`,
    [`%${q}%`]
  );
  res.json(users);
});
