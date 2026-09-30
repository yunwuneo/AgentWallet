import { existsSync } from 'node:fs';

export interface DemoConfig {
  /** Shows the "体验演示" entry and allows creating temporary demo users. */
  enabled: boolean;
  /** How long a demo user lives before it stops working and is purged. */
  ttlMs: number;
  /** Cap on simultaneously active demo users. */
  maxActive: number;
  /** Demo users one IP may create per hour. */
  perIpPerHour: number;
}

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  demo: DemoConfig;
}

export const DEFAULT_DEMO: DemoConfig = { enabled: false, ttlMs: 24 * 60 * 60 * 1000, maxActive: 200, perIpPerHour: 5 };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  const ttlHours = Number(env.DEMO_TTL_HOURS ?? 24);
  if (!(ttlHours > 0)) throw new Error(`Invalid DEMO_TTL_HOURS: ${env.DEMO_TTL_HOURS}`);
  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    databasePath: env.DATABASE_PATH ?? './data/agentwallet.db',
    demo: { ...DEFAULT_DEMO, enabled: env.DEMO_ENABLED === 'true', ttlMs: ttlHours * 60 * 60 * 1000 },
  };
}

/**
 * Loads `.env` from the working directory into process.env, if the file exists.
 * Variables already set in the environment take precedence over the file.
 */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
