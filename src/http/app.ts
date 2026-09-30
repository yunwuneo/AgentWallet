import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { UserService } from '../core/users.js';
import { WalletService } from '../core/wallet.js';
import { createMcpServer } from '../mcp/server.js';

const MAX_BODY_BYTES = 1024 * 1024;

export function createApp(db: Db): Hono<{ Variables: { userId: string } }> {
  const users = new UserService(db);
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get('/healthz', (c) => c.json({ ok: true }));

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
    const server = createMcpServer(new WalletService(db, c.get('userId')));
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

  return app;
}
