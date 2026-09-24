import { db } from '../db';

/**
 * Every user gets exactly one personal list on account creation — their
 * private space for connections nobody else can see. List-level permission
 * rows are still the single source of truth for access (owner_id alone
 * doesn't grant anything), so this also inserts the 'admin' grant for the
 * owner, same as any other list permission.
 */
export async function provisionPersonalList(userId: string): Promise<string> {
  const list = await db.one(
    `INSERT INTO connection_lists (name, description, owner_id, is_personal)
     VALUES ('My Connections', 'Private connections only you can see.', $1, true)
     RETURNING id`,
    [userId]
  );
  await grantListPermission(list.id, userId, 'admin');
  return list.id;
}

export async function grantListPermission(listId: string, userId: string, permission: string): Promise<void> {
  await db.none(
    `INSERT INTO list_user_permissions (list_id, user_id, permission) VALUES ($1, $2, $3)
     ON CONFLICT (list_id, user_id, permission) DO NOTHING`,
    [listId, userId, permission]
  );
}
