import { Client } from 'ssh2';
import { db } from '../db';
import { decryptCredential } from './vaultClient';

/**
 * Pushes a pasted file to the remote host over SFTP, using the same vaulted
 * credentials already configured for this connection — the user never sees
 * a second auth prompt, since this reuses whatever credential (shared or
 * their own individual one) they already connected with.
 *
 * Honest simplification vs. the ideal design: guacd — not this Node process —
 * owns the actual terminal SSH session, so this opens its own short-lived
 * SFTP-only connection rather than truly multiplexing a channel on guacd's
 * existing socket (which guacd doesn't expose a hook for). User-facing result
 * is identical (no visible re-auth), but it is a second protocol-level
 * connection under the hood. Revisit if guacd ever exposes channel access.
 */
export async function pushFileViaSftp(
  connectionId: string,
  userId: string,
  fileBuffer: Buffer,
  filename: string
): Promise<string> {
  const connection = await db.one(
    `SELECT hostname, port, credential_mode FROM connections WHERE id = $1`,
    [connectionId]
  );
  const credRow = await db.one(
    `SELECT username_encrypted, secret_encrypted FROM connection_credentials
     WHERE connection_id = $1 AND (user_id = $2 OR user_id IS NULL)
     ORDER BY user_id NULLS LAST LIMIT 1`,
    [connectionId, connection.credential_mode === 'individual' ? userId : null]
  );

  const username = await decryptCredential(credRow.username_encrypted);
  const password = await decryptCredential(credRow.secret_encrypted);

  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) return reject(err);

          const remoteDir = `guac-uploads`;
          sftp.mkdir(remoteDir, () => {
            // Ignore mkdir errors (directory likely already exists) and proceed to write
            const remotePath = `${remoteDir}/${filename}`;
            const writeStream = sftp.createWriteStream(remotePath);
            writeStream.on('close', () => {
              conn.end();
              resolve(remotePath);
            });
            writeStream.on('error', (streamErr: Error) => {
              conn.end();
              reject(streamErr);
            });
            writeStream.end(fileBuffer);
          });
        });
      })
      .on('error', reject)
      .connect({ host: connection.hostname, port: connection.port, username, password });
  });
}
