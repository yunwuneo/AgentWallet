import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { WalletEvents } from '../core/events.js';
import { UserService } from '../core/users.js';
import { WalletService } from '../core/wallet.js';
import { createMcpServer } from '../mcp/server.js';
import { createApi, type ApiDeps } from './api.js';

const MAX_BODY_BYTES = 1024 * 1024;

/** Built web console; same relative location from src/http and dist/http. */
export const DEFAULT_WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export interface AppOptions {
  events?: WalletEvents;
  /** Directory of the built web console; defaults to web/dist. */
  webDist?: string;
  heartbeatMs?: ApiDeps['heartbeatMs'];
}

/** One Hono app serving MCP at /mcp, the web API at /api and the web console everywhere else. */
export function createApp(db: Db, opts: AppOptions = {}): Hono<{ Variables: { userId: string } }> {
  const events = opts.events ?? new WalletEvents();
  const users = new UserService(db);
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get('/healthz', (c) => c.json({ ok: true }));

  // ------------------------------------------------------------------- MCP

  app.use('/mcp', async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
    const userId = token ? users.authenticate(token) : undefined;
    if (!userId) {
      return c.json({ error: 'unauthorized', message: 'Missing or invalid API key' }, 401, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    c.set('userId', userId);
    await next();
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, bound to the authenticated user.
  app.all('/mcp', async (c) => {
    const server = createMcpServer(new WalletService(db, c.get('userId'), { events }));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  // ------------------------------------------------------------------- API

  app.route('/api', createApi({ db, events, heartbeatMs: opts.heartbeatMs }));

  // ------------------------------------------------------------ web console

  const webDist = opts.webDist ?? DEFAULT_WEB_DIST;
  if (existsSync(resolve(webDist, 'index.html'))) {
    app.use(
      '*',
      serveStatic({
        root: webDist,
        onFound: (path, c) => {
          // Vite fingerprints everything under /assets, so those can be cached forever.
          c.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    // Client-side routes (e.g. /accounts/acc_x) fall back to the SPA shell.
    app.get(
      '*',
      serveStatic({
        root: webDist,
        path: 'index.html',
        onFound: (_path, c) => {
          c.header('Cache-Control', 'no-cache');
        },
      }),
    );
  } else {
    app.get('/', (c) =>
      c.text('AgentWallet is running. The web console is not built yet: run `pnpm build`.', 200),
    );
  }

  return app;
}
