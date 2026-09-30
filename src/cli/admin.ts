#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '../config.js';
import { WalletError } from '../core/errors.js';
import { formatTime } from '../core/time.js';
import { DEFAULT_PLAYER_NAME, UserService } from '../core/users.js';
import { openDb } from '../db/client.js';

const USAGE = `Usage: agentwallet-admin <command> [options]

Commands:
  create-user --name <name> [--player-name <name>] [--with-key]
                                  Create a user (and their player account, default "${DEFAULT_PLAYER_NAME}")
  list-users                      List users
  create-key --user <id> [--label <label>]
                                  Issue an API key (shown once)
  list-keys --user <id>           List a user's API keys
  revoke-key --key-id <id>        Revoke an API key

Environment: DATABASE_PATH (default ./data/agentwallet.db); also read from .env if present`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      'player-name': { type: 'string' },
      'with-key': { type: 'boolean' },
      user: { type: 'string' },
      label: { type: 'string' },
      'key-id': { type: 'string' },
    },
  });

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const require = (key: keyof typeof values): string => {
    const v = values[key];
    if (typeof v !== 'string' || !v) throw new UsageError(`--${key} is required`);
    return v;
  };

  loadDotEnv();
  const users = new UserService(openDb(loadConfig().databasePath));

  switch (command) {
    case 'create-user': {
      const user = users.createUser({ name: require('name'), playerName: values['player-name'] });
      console.log(`user id: ${user.id}`);
      if (values['with-key']) printKey(users.createApiKey(user.id, 'default'));
      return 0;
    }
    case 'list-users':
      for (const u of users.listUsers()) console.log(`${u.id}\t${u.name}\t${formatTime(u.createdAt)}`);
      return 0;
    case 'create-key':
      printKey(users.createApiKey(require('user'), values.label));
      return 0;
    case 'list-keys':
      for (const k of users.listApiKeys(require('user'))) {
        const state = k.revokedAt === null ? 'active' : `revoked ${formatTime(k.revokedAt)}`;
        console.log(`${k.id}\t${k.label ?? ''}\t${formatTime(k.createdAt)}\t${state}`);
      }
      return 0;
    case 'revoke-key': {
      const keyId = require('key-id');
      if (!users.revokeApiKey(keyId)) {
        console.error(`No active key ${keyId}`);
        return 1;
      }
      console.log(`revoked ${keyId}`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

function printKey({ id, key }: { id: string; key: string }): void {
  console.log(`key id:  ${id}`);
  console.log(`api key: ${key}`);
  console.log('(This key is shown only once. Store it securely.)');
}

class UsageError extends Error {}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else if (err instanceof WalletError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
