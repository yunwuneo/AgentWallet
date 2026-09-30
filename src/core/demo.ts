import type { DbHandle } from '../db/client.js';
import type { User } from '../db/schema.js';
import type { UserService } from './users.js';
import { WalletService, type PartyInput } from './wallet.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Creates a temporary demo user with a player wallet, three agent wallets and about two weeks
 * of sample role-play transactions, so a visitor lands on a console that already tells a story.
 */
export function createDemoUser(db: DbHandle, users: UserService, opts: { ttlMs: number; now?: number }): User {
  const now = opts.now ?? Date.now();
  let clock = now - 13 * DAY;
  const at = () => clock;

  const user = users.createUser({ name: '演示用户', playerName: '主人', demoExpiresAt: now + opts.ttlMs });
  const wallet = new WalletService(db, user.id, { now: at });

  wallet.createAccount({ name: '家机A', initialBalance: 50_000 });
  wallet.createAccount({ name: '家机B', overdraftLimit: 100_000 });
  wallet.createAccount({ name: '小爱', initialBalance: 12_000 });

  const record = (hoursLater: number, from: PartyInput, to: PartyInput, yuan: number, reason: string) => {
    clock += hoursLater * HOUR;
    return wallet.recordTransaction({ from, to, amount: Math.round(yuan * 100), reason }).transaction;
  };
  const player = { account: '主人' };
  const a = { account: '家机A' };
  const b = { account: '家机B' };
  const ai = { account: '小爱' };

  record(3, { external: '公司' }, player, 18_000, '九月工资');
  record(20, { external: 'XX科技' }, a, 8_000, '九月工资');
  record(30, a, { external: '便利店' }, 12.5, '零食');
  record(26, player, b, 500, '零花钱');
  record(22, b, { external: '书店' }, 868, '买了一套编程书');
  const oops = record(30, { external: '彩票站' }, ai, 100_000, '中了彩票？');
  wallet.voidTransaction(oops.id, '剧情回退：只是一场梦');
  record(40, { external: '夜市兼职' }, ai, 320, '夜市兼职收入');
  record(25, a, ai, 200, '请小爱喝奶茶');
  record(30, player, { external: '房东' }, 4_500, '房租');
  clock = now - 5 * HOUR;
  record(1, a, { external: '花店' }, 99, '给主人买花');
  record(2, { external: '杂志社' }, a, 1_500, '投稿稿费');
  return user;
}
