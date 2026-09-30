import { serve } from '@hono/node-server';
import { loadConfig, loadDotEnv } from './config.js';
import { openDb } from './db/client.js';
import { createApp } from './http/app.js';

loadDotEnv();
const config = loadConfig();
const db = openDb(config.databasePath);
const app = createApp(db);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`AgentWallet listening on http://${info.address}:${info.port} (MCP endpoint: /mcp)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.$client.close();
      process.exit(0);
    });
  });
}
