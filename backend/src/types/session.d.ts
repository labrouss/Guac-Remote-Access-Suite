import 'express-session';

declare module 'express-session' {
  interface SessionData {
    setupUserId?: string;
    pendingTotpSecret?: string;
  }
}
