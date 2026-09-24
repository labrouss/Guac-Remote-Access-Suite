import { createServer } from 'http';
import { createApp } from './app';
import { attachBookmarkProxyWebsockets } from './routes/bookmarkProxy';
import { attachGuacTunnel } from './services/guacTunnel';
import { logger } from './services/logger';

const app = createApp();
const httpServer = createServer(app);

// guacamole-lite attaches its own WebSocket upgrade handling to the same
// HTTP server instance, so one process serves both the REST API and the
// live Guacamole tunnel.
attachGuacTunnel(httpServer);

// Separate 'upgrade' listener for proxied bookmarks that need WebSocket
// support (enable_websocket = true) — coexists with guacamole-lite's own
// listener on the same server; each ignores requests outside its own path.
attachBookmarkProxyWebsockets(httpServer);

const PORT = Number(process.env.PORT ?? 8080);
httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'guac-access-suite backend listening');
});
