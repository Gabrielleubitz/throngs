import { describe, expect, it } from 'vitest';

import { type Mark, newGame, type PongGame, pongStep, type TttGame, tttPickMove, tttStep, tttWinner } from '../src/sm/games.js';

const P = (id: string) => ({ id, name: id.toUpperCase() });

describe('tic-tac-toe', () => {
  it('detects winners and draws', () => {
    expect(tttWinner(['X', 'X', 'X', null, 'O', 'O', null, null, null])).toBe('X');
    expect(tttWinner(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'])).toBe('draw');
    expect(tttWinner(Array(9).fill(null) as Mark[])).toBeNull();
  });
  it('takes a win, otherwise blocks', () => {
    expect(tttPickMove(['X', 'X', null, 'O', 'O', null, null, null, null], 'X')).toBe(2);
    expect(tttPickMove(['X', 'X', null, null, 'O', null, null, null, null], 'O')).toBe(2);
  });
  it('plays whole games to a result and scores them', () => {
    const g = newGame('tictactoe', 1, [P('a'), P('b')]) as TttGame;
    let finished = false;
    for (let i = 0; i < 500 && !finished; i++) { tttStep(g); finished = g.winner !== null; }
    expect(finished).toBe(true);
    if (g.winner !== 'draw') expect(g.score[g.winner as 0 | 1]).toBe(1);
  });
});

/** Deterministic PRNG so the pong test is not at the mercy of Math.random. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('pong', () => {
  it('scores points and resets after reaching the win score', () => {
    const rand = seeded(42);
    const g = newGame('pong', 2, [P('a'), P('b')], rand) as PongGame;
    let maxScore = 0;
    for (let i = 0; i < 20000; i++) {
      pongStep(g, rand);
      maxScore = Math.max(maxScore, ...g.score);
      expect(g.ball.y).toBeGreaterThanOrEqual(0);
      if (maxScore >= 5 && g.score[0] === 0 && g.score[1] === 0) break;
    }
    expect(maxScore).toBe(5);
    expect(g.score).toEqual([0, 0]);
  });
});
