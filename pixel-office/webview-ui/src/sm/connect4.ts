/** Connect Four engine (human vs bot) — pure. Board is 6 rows × 7 cols, 0 empty / 1 human / 2 bot. */
export const C4_ROWS = 6, C4_COLS = 7;
export type C4Board = number[][];
export const c4New = (): C4Board => Array.from({ length: C4_ROWS }, () => Array(C4_COLS).fill(0));
export const c4Drop = (b: C4Board, col: number, who: 1 | 2): C4Board | null => {
  for (let r = C4_ROWS - 1; r >= 0; r--) if (!b[r][col]) { const n = b.map((x) => x.slice()); n[r][col] = who; return n; }
  return null;
};
export function c4Winner(b: C4Board): 0 | 1 | 2 | 3 {
  for (let r = 0; r < C4_ROWS; r++) for (let c = 0; c < C4_COLS; c++) {
    const v = b[r][c]; if (!v) continue;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let k = 1; while (k < 4) { const rr = r + dr * k, cc = c + dc * k; if (rr < 0 || rr >= C4_ROWS || cc < 0 || cc >= C4_COLS || b[rr][cc] !== v) break; k++; }
      if (k === 4) return v as 1 | 2;
    }
  }
  return b[0].every(Boolean) ? 3 : 0; // 3 = draw
}
function score(b: C4Board): number {
  let s = 0;
  for (let r = 0; r < C4_ROWS; r++) s += (b[r][3] === 2 ? 3 : b[r][3] === 1 ? -3 : 0);
  for (let r = 0; r < C4_ROWS; r++) for (let c = 0; c < C4_COLS; c++) for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let me = 0, op = 0; for (let k = 0; k < 4; k++) { const rr = r + dr * k, cc = c + dc * k; if (rr < 0 || rr >= C4_ROWS || cc < 0 || cc >= C4_COLS) { me = op = -9; break; } const v = b[rr][cc]; if (v === 2) me++; else if (v === 1) op++; }
    if (me > 0 && op === 0) s += me === 3 ? 5 : me === 2 ? 2 : 0; else if (op > 0 && me === 0) s -= op === 3 ? 6 : op === 2 ? 2 : 0;
  }
  return s;
}
const ORDER = [3, 2, 4, 1, 5, 0, 6];
function search(b: C4Board, depth: number, alpha: number, beta: number, botTurn: boolean): number {
  const w = c4Winner(b);
  if (w === 2) return 1000 + depth; if (w === 1) return -1000 - depth; if (w === 3) return 0;
  if (depth === 0) return score(b);
  let best = botTurn ? -Infinity : Infinity;
  for (const c of ORDER) {
    const n = c4Drop(b, c, botTurn ? 2 : 1); if (!n) continue;
    const v = search(n, depth - 1, alpha, beta, !botTurn);
    if (botTurn) { best = Math.max(best, v); alpha = Math.max(alpha, v); } else { best = Math.min(best, v); beta = Math.min(beta, v); }
    if (beta <= alpha) break;
  }
  return best;
}
/** Bot (player 2) picks a column; `depth` is the strength (4 easy … 7 hard). */
export function c4BotMove(b: C4Board, depth = 5): number {
  let bestC = -1, bestV = -Infinity;
  for (const c of ORDER) {
    const n = c4Drop(b, c, 2); if (!n) continue;
    const v = search(n, depth - 1, -Infinity, Infinity, false);
    if (v > bestV) { bestV = v; bestC = c; }
  }
  return bestC;
}
