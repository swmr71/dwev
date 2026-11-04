// ポイント(使えるメモリ×時間の持ち分)。1ポイント = 1GB のメモリを 1 時間。
//   - 動いている(running)プロジェクトのメモリの合計に比例して、時間とともに減る
//   - いつでも、(上限 ÷ 回復時間)ずつ、時間とともに回復する。上限を超えては貯まらない
//   - 0 になったら、動いているものを止める。起動するときは、少なくとも数分は動かせる残りが要る
// 上限が 0 のときは、この仕組み全体が無効。
import { config } from './config.js';
import { getUser, updateUser, listUsers, listProjects } from './db.js';

const HOUR_MS = 3_600_000;
const MIN_RUN_MINUTES = 5; // 起動に必要な残り(このメモリで、これだけ動かせること)

export const pointsEnabled = () => config.points.cap > 0;
export const capFor = (user) => user.points_cap ?? config.points.cap;
// 1時間あたりの回復量(ポイント)
export const regenPerHour = (user) => capFor(user) / config.points.regenHours;

const memoryGb = (p) => (p.memory_mb ?? config.limits.memoryMb) / 1024;

// 動いているプロジェクトのメモリの合計(GB)。この分が、1時間あたりに減るポイント
export const burnPerHour = (userId) =>
  listProjects(userId).filter((p) => p.status === 'running').reduce((sum, p) => sum + memoryGb(p), 0);

// 残りのポイント(上限を超えない。まだ一度も使っていない人は、満タン)
export const balanceOf = (user) => Math.min(capFor(user), user.points ?? capFor(user));

// いまのメモリ構成のまま動かし続けたとき、何秒で尽きるか。尽きない(回復が上回る)・動いていないときは null
export function secondsUntilEmpty(user) {
  const net = burnPerHour(user.id) - regenPerHour(user);
  if (net <= 0) return null;
  return Math.max(0, Math.floor((balanceOf(user) / net) * 3600));
}

// 動かし始めるのに足りているか。足りなければ、理由(回復までの目安つき)を返す。足りていれば null
export function pointsShortage(user, memoryMb) {
  if (!pointsEnabled()) return null;
  const need = (memoryMb / 1024) * (MIN_RUN_MINUTES / 60);
  const have = balanceOf(user);
  if (have >= need) return null;
  const waitMin = Math.ceil(((need - have) / regenPerHour(user)) * 60);
  return `ポイントが足りません(残り ${have.toFixed(2)} pt)。${memoryMb}MB を動かすには、あと ${waitMin} 分ほど回復を待つか、メモリを小さくしてください`;
}

// 時間の経過ぶんを、残高に反映する。5秒ごとに、全員分を呼ぶ。
// 前回からの経過は maxStepMs までしか見ない(止まっていた間に、まとめて減らさないため)。
const lastTick = new Map(); // userId -> 前回の時刻
export function settleAll(nowMs = Date.now(), maxStepMs = 60_000) {
  if (!pointsEnabled()) return;
  for (const u of listUsers()) {
    const prev = lastTick.get(u.id) ?? nowMs;
    lastTick.set(u.id, nowMs);
    const cap = capFor(u);
    const base = u.points ?? cap;
    const dtH = Math.max(0, Math.min(nowMs - prev, maxStepMs)) / HOUR_MS;
    const next = Math.min(cap, Math.max(0, base + (regenPerHour(u) - burnPerHour(u.id)) * dtH));
    if (next !== base || u.points == null) updateUser(u.id, { points: next });
  }
}

// 画面と管理用の表現
export function presentPoints(user) {
  if (!pointsEnabled()) return { enabled: false };
  return {
    enabled: true,
    balance: Math.round(balanceOf(user) * 1000) / 1000,
    cap: capFor(user),
    regenPerHour: Math.round(regenPerHour(user) * 1000) / 1000,
    burnPerHour: burnPerHour(user.id),
  };
}

export const userPoints = (userId) => {
  const u = getUser(userId);
  return u ? balanceOf(u) : 0;
};
