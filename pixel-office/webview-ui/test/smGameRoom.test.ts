import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import { type BasketGame, basketStep, newBasketGame } from '../src/sm/basketball.js';
import { chessBotMove } from '../src/sm/chessBot.js';
import { c4BotMove, c4Drop, c4New, c4Winner } from '../src/sm/connect4.js';
import { type ChessGame, chessStep, newGame, planGames } from '../src/sm/games.js';

const P = (id: string) => ({ id, name: id.toUpperCase() });

describe('game planning', () => {
  it('gives idle crew things to do in priority order', () => {
    expect(planGames(1)).toEqual([]);
    expect(planGames(2).map((p) => p.kind)).toEqual(['tictactoe']);
    expect(planGames(4).map((p) => [p.kind, p.count])).toEqual([['tictactoe', 2], ['basketball', 2]]);
    expect(planGames(10).map((p) => p.kind)).toEqual(['tictactoe', 'basketball', 'pong', 'chess']);
  });
});

describe('basketball', () => {
  it('plays real games: shots, scoring and match resets', () => {
    const g = newBasketGame(2, ['a', 'b', 'c', 'd'].map(P)) as BasketGame;
    expect(g.hoopers.map((h) => h.team)).toEqual([0, 1, 0, 1]);
    let scored = 0, wins = 0, prev = [0, 0];
    for (let i = 0; i < 20000; i++) {
      basketStep(g);
      if (g.score[0] + g.score[1] > prev[0] + prev[1]) scored++;
      if (g.score[0] + g.score[1] === 0 && prev[0] + prev[1] > 0) wins++;
      prev = [...g.score];
      for (const h of g.hoopers) { expect(h.x).toBeGreaterThanOrEqual(0); expect(h.x).toBeLessThanOrEqual(100); }
    }
    expect(scored).toBeGreaterThan(20);
    expect(wins).toBeGreaterThan(0);
  });
  it('supports 1v1', () => {
    const g = newBasketGame(2, [P('a'), P('b')]);
    for (let i = 0; i < 2000; i++) basketStep(g);
    expect(g.hoopers).toHaveLength(2);
  });
});

describe('connect four', () => {
  it('detects wins and blocks', () => {
    let b = c4New();
    for (let i = 0; i < 4; i++) b = c4Drop(b, i, 1)!;
    expect(c4Winner(b)).toBe(1);
    let t = c4New();
    for (let i = 0; i < 3; i++) t = c4Drop(t, 0, 1)!;
    expect(c4BotMove(t, 4)).toBe(0); // bot must block the column
  });
  it('bot takes an immediate win', () => {
    let b = c4New();
    for (let i = 0; i < 3; i++) b = c4Drop(b, 2, 2)!;
    expect(c4BotMove(b, 4)).toBe(2);
  });
});

describe('chess bot (js-chess-engine)', () => {
  it('replies with a legal move and finds mate in one', () => {
    const c = new Chess();
    c.move('e4');
    const m = chessBotMove(c, 2);
    expect(m).not.toBeNull();
    expect(c.history()).toHaveLength(2);
    const mate = new Chess('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
    chessBotMove(mate, 3);
    expect(mate.isCheckmate()).toBe(true);
  });
  it('crew chess table plays moves and restarts', () => {
    const g = newGame('chess', 3, [P('a'), P('b')]) as ChessGame;
    for (let i = 0; i < 300; i++) chessStep(g);
    expect(g.chess.history().length + (g.pause > 0 ? 1 : 0)).toBeGreaterThan(0);
  });
});
