/**
 * Game Room engine — pure, dependency-free. Idle crew are paired up at two tables and play
 * tic-tac-toe (table 1) and pong (table 2). The UI only renders `getGames()` snapshots.
 */
import { Chess } from 'chess.js';

import { type BasketGame, basketStep, newBasketGame } from './basketball.js';
import { chessBotMove, chessStatus } from './chessBot.js';

export type Mark = 'X' | 'O' | null;
export interface Player { id: string; name: string }

export interface TttGame {
  kind: 'tictactoe'; table: number; players: [Player, Player];
  board: Mark[]; turn: 0 | 1; winner: 0 | 1 | 'draw' | null; score: [number, number]; pause: number; tick: number;
}
export interface PongGame {
  kind: 'pong'; table: number; players: [Player, Player];
  ball: { x: number; y: number; vx: number; vy: number }; paddles: [number, number];
  score: [number, number]; pause: number;
}
export interface ChessGame {
  kind: 'chess'; table: number; players: [Player, Player]; chess: Chess; score: [number, number]; pause: number; tick: number; last: string;
}
export type Game = TttGame | PongGame | ChessGame | BasketGame;

export const PONG_W = 100, PONG_H = 60, PADDLE_H = 14, WIN_SCORE = 5;
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const TTT_STEP_TICKS = 8; // ticks (100 ms) per tic-tac-toe move
const PAUSE_TICKS = 25;
const CHESS_STEP_TICKS = 14; // ~1.4 s per chess move

export function tttWinner(b: Mark[]): 'X' | 'O' | 'draw' | null {
  for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a] as 'X' | 'O';
  return b.every(Boolean) ? 'draw' : null;
}

/** Win if possible, else block, else centre, else random. */
export function tttPickMove(b: Mark[], me: 'X' | 'O', rand: () => number = Math.random): number {
  const opp = me === 'X' ? 'O' : 'X';
  const free = b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  for (const who of [me, opp] as Mark[]) {
    for (const i of free) {
      const t = b.slice(); t[i] = who;
      if (tttWinner(t) === who) return i;
    }
  }
  if (!b[4]) return 4;
  return free[Math.floor(rand() * free.length)];
}

export function tttStep(g: TttGame, rand: () => number = Math.random): void {
  if (g.winner) {
    if (--g.pause <= 0) { g.board = Array(9).fill(null); g.winner = null; g.turn = g.turn === 0 ? 1 : 0; g.tick = 0; }
    return;
  }
  if (++g.tick < TTT_STEP_TICKS) return;
  g.tick = 0;
  const mark: 'X' | 'O' = g.turn === 0 ? 'X' : 'O';
  // 25% of the time make a random move so games aren't always draws
  const free = g.board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  const move = rand() < 0.25 ? free[Math.floor(rand() * free.length)] : tttPickMove(g.board, mark, rand);
  g.board[move] = mark;
  const w = tttWinner(g.board);
  if (w) {
    g.winner = w === 'draw' ? 'draw' : w === 'X' ? 0 : 1;
    if (g.winner !== 'draw') g.score[g.winner]++;
    g.pause = PAUSE_TICKS;
  } else g.turn = g.turn === 0 ? 1 : 0;
}

function serve(g: PongGame, dir: 1 | -1, rand: () => number): void {
  g.ball = { x: PONG_W / 2, y: PONG_H / 2, vx: 1.1 * dir, vy: (rand() - 0.5) * 1.2 };
}

export function pongStep(g: PongGame, rand: () => number = Math.random): void {
  if (g.pause > 0) {
    if (--g.pause === 0 && (g.score[0] >= WIN_SCORE || g.score[1] >= WIN_SCORE)) { g.score = [0, 0]; serve(g, rand() < 0.5 ? 1 : -1, rand); }
    return;
  }
  const b = g.ball;
  b.x += b.vx; b.y += b.vy;
  if (b.y < 0) { b.y = 0; b.vy = Math.abs(b.vy); }
  if (b.y > PONG_H) { b.y = PONG_H; b.vy = -Math.abs(b.vy); }
  // each paddle chases the ball, slightly imperfectly (speed-capped), so points get scored
  for (const i of [0, 1] as const) {
    const diff = b.y - g.paddles[i];
    g.paddles[i] = Math.max(PADDLE_H / 2, Math.min(PONG_H - PADDLE_H / 2, g.paddles[i] + Math.max(-0.75, Math.min(0.75, diff))));
  }
  const hit = (i: 0 | 1) => Math.abs(b.y - g.paddles[i]) <= PADDLE_H / 2 + 1;
  if (b.x <= 2 && b.vx < 0) {
    if (hit(0)) { b.vx = Math.abs(b.vx) * 1.05; b.vy += (b.y - g.paddles[0]) * 0.08; b.x = 2; }
    else if (b.x < 0) { g.score[1]++; g.pause = PAUSE_TICKS; serve(g, 1, rand); }
  } else if (b.x >= PONG_W - 2 && b.vx > 0) {
    if (hit(1)) { b.vx = -Math.abs(b.vx) * 1.05; b.vy += (b.y - g.paddles[1]) * 0.08; b.x = PONG_W - 2; }
    else if (b.x > PONG_W) { g.score[0]++; g.pause = PAUSE_TICKS; serve(g, -1, rand); }
  }
  b.vx = Math.max(-2.2, Math.min(2.2, b.vx)); b.vy = Math.max(-1.6, Math.min(1.6, b.vy));
  if (g.score[0] >= WIN_SCORE || g.score[1] >= WIN_SCORE) g.pause = PAUSE_TICKS * 2;
}

export function chessStep(g: ChessGame): void {
  if (g.pause > 0) {
    if (--g.pause === 0) { g.chess = new Chess(); g.last = 'New game'; g.tick = 0; }
    return;
  }
  if (++g.tick < CHESS_STEP_TICKS) return;
  g.tick = 0;
  const m = chessBotMove(g.chess, 1);
  const over = chessStatus(g.chess);
  if (m) g.last = m.san;
  if (over || !m) {
    g.last = over ?? 'Game over';
    if (g.chess.isCheckmate()) g.score[g.chess.turn() === 'w' ? 1 : 0]++;
    g.pause = PAUSE_TICKS * 3;
  } else if (g.chess.history().length > 120) g.pause = 1;
}

export function newGame(kind: Game['kind'], table: number, players: [Player, Player], rand: () => number = Math.random, people?: Player[]): Game {
  if (kind === 'pong') {
    const g: PongGame = { kind: 'pong', table, players, ball: { x: 0, y: 0, vx: 0, vy: 0 }, paddles: [PONG_H / 2, PONG_H / 2], score: [0, 0], pause: 0 };
    serve(g, rand() < 0.5 ? 1 : -1, rand);
    return g;
  }
  if (kind === 'chess') return { kind: 'chess', table, players, chess: new Chess(), score: [0, 0], pause: 0, tick: 0, last: 'Opening' };
  if (kind === 'basketball') return newBasketGame(table, people ?? players, rand);
  return { kind: 'tictactoe', table, players, board: Array(9).fill(null), turn: 0, winner: null, score: [0, 0], pause: 0, tick: 0 };
}

// ── live store ──
let games: Game[] = [];
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot: Game[] = [];

const emit = () => { snapshot = [...games]; for (const f of subs) f(); };

const stepGame = (g: Game): void => {
  if (g.kind === 'pong') pongStep(g); else if (g.kind === 'tictactoe') tttStep(g); else if (g.kind === 'chess') chessStep(g); else basketStep(g);
};

/** Who plays what, in priority order: [kind, min people, max people]. People left over just rest. */
const PLAN: [Game['kind'], number, number][] = [['tictactoe', 2, 2], ['basketball', 2, 4], ['pong', 2, 2], ['chess', 2, 2]];

export const planGames = (n: number): { kind: Game['kind']; from: number; count: number }[] => {
  const out: { kind: Game['kind']; from: number; count: number }[] = [];
  let at = 0;
  for (const [kind, min, max] of PLAN) {
    const left = n - at;
    if (left < min) break;
    const count = kind === 'basketball' ? Math.min(max, left - (left % 2)) : max;
    out.push({ kind, from: at, count });
    at += count;
  }
  return out;
};

const sig = (g: Game): string => `${g.kind}|${g.kind === 'basketball' ? g.hoopers.map((h) => h.id).join(',') : g.players.map((p) => p.id).join(',')}`;

/** Assign the idle people to games (see PLAN). Keeps games whose players are unchanged. */
export function syncPlayers(idle: Player[]): void {
  const next: Game[] = planGames(idle.length).map((p, i) => {
    const ps = idle.slice(p.from, p.from + p.count);
    const want = `${p.kind}|${ps.map((x) => x.id).join(',')}`;
    return games.find((g) => sig(g) === want) ?? newGame(p.kind, i + 1, [ps[0], ps[1]], undefined, ps);
  });
  const same = next.length === games.length && next.every((g, i) => g === games[i]);
  games = next;
  if (!same) emit();
  if (games.length && !timer) {
    timer = setInterval(() => { for (const g of games) stepGame(g); emit(); }, 100);
  } else if (!games.length && timer) { clearInterval(timer); timer = null; }
}

export const getGames = (): Game[] => snapshot;
export const subscribeGames = (f: () => void): (() => void) => { subs.add(f); return () => { subs.delete(f); }; };
