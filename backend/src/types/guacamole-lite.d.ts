declare module 'guacamole-lite' {
  import { Server as HttpServer } from 'http';
  import { EventEmitter } from 'events';

  interface GuacdOptions {
    host?: string;
    port?: number;
  }

  interface ClientOptions {
    // string | Buffer, not just string — Crypt.js's constructor does
    // `this.key = key` with zero transformation of its own, and passes it
    // straight to Node's own Crypto.createDecipheriv(), which genuinely
    // accepts a Buffer directly (this is actually the safer choice than a
    // raw string, avoiding any implicit string-encoding ambiguity
    // entirely) — confirmed by reading Crypt.js's real source directly,
    // the same discipline already used for the other types in this file.
    crypt?: { cypher?: string; key?: string | Buffer };
    connectionDefaultSettings?: Record<string, unknown>;
    allowedUnencryptedConnectionSettings?: Record<string, string[]>;
    log?: { level?: string; stdLog?: (...args: unknown[]) => void; errorLog?: (...args: unknown[]) => void };
    maxInactivityTime?: number;
    [key: string]: unknown;
  }

  /**
   * Map-like interface guacamole-lite requires for cross-instance join
   * routing when horizontally scaled (see docs/TESTING_PLAN.md and
   * techdetails.md — this app doesn't provide one, so the library falls
   * back to its own in-memory Map, which only works correctly with a
   * single backend replica). Each method may be sync or return a Promise.
   */
  interface SessionRegistry {
    get(sessionId: string): unknown | Promise<unknown>;
    set(sessionId: string, data: unknown): void | Promise<void>;
    delete(sessionId: string): void | Promise<void>;
  }

  interface Callbacks {
    processConnectionSettings?: (
      settings: any,
      callback: (err: Error | null, settings: any) => void
    ) => void;
    sessionRegistry?: SessionRegistry;
    [key: string]: unknown;
  }

  /**
   * Verified directly against the real installed 1.2.0 source
   * (lib/ClientConnection.js, lib/GuacdClient.js) rather than assumed from
   * the README alone — `guacamoleConnectionId` is only reliably populated
   * once guacd's own `ready` instruction has been processed, which is
   * exactly when the top-level 'open' event fires (see GuacdClient.js:
   * `this.guacamoleConnectionId = params[0]` happens inside the `ready`
   * opcode handler, immediately before `this.emit('open', this)`).
   */
  interface ClientConnection extends EventEmitter {
    connectionId: number | string; // guacamole-lite's own internal per-websocket id — NOT the guacd join id
    guacamoleConnectionId: string; // the real guacd-assigned id, usable as a `join` target — e.g. "$b447679c-..."
    connectionSettings: any; // the full decrypted token payload
    guacdClient: EventEmitter; // emits 'data' with the raw outgoing instruction stream — see services/guacTunnel.ts's recording tap
  }

  class GuacamoleLite {
    constructor(
      serverOptions: { server: HttpServer },
      guacdOptions: GuacdOptions,
      clientOptions?: ClientOptions,
      callbacks?: Callbacks
    );
    on(event: 'open', listener: (clientConnection: ClientConnection) => void): void;
    on(event: 'close', listener: (clientConnection: ClientConnection, error?: Error) => void): void;
    on(event: 'error', listener: (clientConnection: ClientConnection, error: Error) => void): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }

  export = GuacamoleLite;
}
