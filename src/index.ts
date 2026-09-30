import { serve } from '@hono/node-server';
import { loadConfig, loadDotEnv } from './config.js';
import { UserService } from './core/users.js';
import { openDb } from './db/client.js';
import { createApp } from './http/app.js';

loadDotEnv();
const config = loadConfig();
const db = openDb(config.databasePath);
const app = createApp(db, { demo: config.demo });

// Expired demo users stop working immediately; this deletes their data. Runs even when the demo
// entry is disabled, so demo users created before it was switched off still get cleaned up.
const users = new UserService(db);
const purge = () => {
  const n = users.purgeExpiredDemos();
  if (n > 0) console.log(`Purged ${n} expired demo user(s)`);
};
purge();
setInterval(purge, 10 * 60 * 1000).unref();

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`AgentWallet listening on http://${info.address}:${info.port} (MCP endpoint: /mcp)`);
  if (config.demo.enabled) console.log(`Demo entry enabled (demo users expire after ${config.demo.ttlMs / 3_600_000}h)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.$client.close();
      process.exit(0);
    });
  });
}
