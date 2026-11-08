/** "Play the crew" tab: tic-tac-toe, connect four and chess against a no-AI bot (chess = js-chess-engine). */
import { Chess, type Square } from 'chess.js';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { chessBotMove, chessStatus } from './chessBot.js';
import { C4_COLS, c4BotMove, c4Drop, c4New, c4Winner } from './connect4.js';
import { C4_BOARD, C4_RED, C4_YELLOW, INK } from './gameColors.js';
import { type Mark, tttPickMove, tttWinner } from './games.js';
import { SmChessBoard } from './SmChessBoard.js';

type Pick = 'ttt' | 'c4' | 'chess';
const LEVELS = [{ n: 1, label: 'Easy' }, { n: 2, label: 'Medium' }, { n: 3, label: 'Hard' }, { n: 4, label: 'Expert' }];

function PlayTtt({ opp }: { opp: string }) {
  const [board, setBoard] = useState<Mark[]>(Array(9).fill(null));
  const w = tttWinner(board);
  const click = (i: number) => {
    if (board[i] || w) return;
    const b = board.slice(); b[i] = 'X';
    if (!tttWinner(b)) b[tttPickMove(b, 'O', Math.random)] = 'O';
    setBoard(b);
  };
  const status = w === 'draw' ? "It's a draw" : w === 'X' ? 'You win!' : w === 'O' ? `${opp} wins` : 'Your move (X)';
  return (
    <>
      <div className="grid grid-cols-3 gap-4 w-[170px] mx-auto">
        {board.map((m, i) => (
          <button key={i} data-cell={i} onClick={() => click(i)} className="h-[52px] border-2 border-border bg-bg-dark text-lg cursor-pointer"
            style={{ color: m === 'X' ? 'var(--color-accent-bright)' : 'var(--color-sm-gold)' }}>{m}</button>
        ))}
      </div>
      <div className="text-2xs text-center text-text-muted">{status}</div>
      <Button size="sm" onClick={() => setBoard(Array(9).fill(null))}>New game</Button>
    </>
  );
}

function PlayC4({ opp }: { opp: string }) {
  const [board, setBoard] = useState(c4New);
  const [level, setLevel] = useState(2);
  const w = c4Winner(board);
  const click = (col: number) => {
    if (w) return;
    const a = c4Drop(board, col, 1); if (!a) return;
    if (c4Winner(a)) { setBoard(a); return; }
    const bc = c4BotMove(a, 3 + level);
    setBoard(bc >= 0 ? c4Drop(a, bc, 2) ?? a : a);
  };
  const status = w === 3 ? "It's a draw" : w === 1 ? 'You win!' : w === 2 ? `${opp} wins` : 'Your move (red) — click a column';
  return (
    <>
      <div className="mx-auto p-4 border-2 border-border" style={{ background: C4_BOARD, width: 'fit-content' }}>
        <div className="grid" style={{ gridTemplateColumns: `repeat(${C4_COLS}, 34px)`, gap: 3 }}>
          {board.flatMap((row, r) => row.map((v, c) => (
            <div key={`${r}-${c}`} data-col={c} onClick={() => click(c)} className="cursor-pointer"
              style={{ width: 34, height: 34, borderRadius: '50%', background: v === 1 ? C4_RED : v === 2 ? C4_YELLOW : INK }} />
          )))}
        </div>
      </div>
      <div className="text-2xs text-center text-text-muted">{status}</div>
      <div className="flex gap-4 justify-center items-center">
        {LEVELS.slice(0, 3).map((l) => <Button key={l.n} size="sm" variant={level === l.n ? 'accent' : 'default'} onClick={() => setLevel(l.n)}>{l.label}</Button>)}
        <Button size="sm" onClick={() => setBoard(c4New())}>New game</Button>
      </div>
    </>
  );
}

function PlayChess({ opp }: { opp: string }) {
  const chessRef = useRef(new Chess());
  const [, bump] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [level, setLevel] = useState(2);
  const [last, setLast] = useState<{ from: string; to: string } | null>(null);
  const [thinking, setThinking] = useState(false);
  const chess = chessRef.current;
  const over = chessStatus(chess);
  const targets = sel ? chess.moves({ square: sel as Square, verbose: true }).map((m) => m.to) : [];
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const click = (sq: Square) => {
    if (thinking || over || chess.turn() !== 'w') return;
    if (sel && targets.includes(sq)) {
      const m = chess.move({ from: sel as Square, to: sq, promotion: 'q' });
      setLast({ from: m.from, to: m.to }); setSel(null); bump((n) => n + 1);
      if (chess.isGameOver()) return;
      setThinking(true);
      timer.current = setTimeout(() => { // let the "thinking…" paint before the engine blocks the thread
        const r = chessBotMove(chess, level);
        if (r) setLast({ from: r.from, to: r.to });
        setThinking(false); bump((n) => n + 1);
      }, 60);
      return;
    }
    const p = chess.get(sq);
    setSel(p && p.color === 'w' ? sq : null);
  };
  const reset = () => { chessRef.current = new Chess(); setSel(null); setLast(null); setThinking(false); bump((n) => n + 1); };
  const status = over ?? (thinking ? `${opp} is thinking…` : chess.inCheck() ? 'Check! Your move (white)' : 'Your move (white)');
  return (
    <>
      <SmChessBoard chess={chess} selected={sel} targets={targets} last={last} onSquare={click} />
      <div className="text-2xs text-center text-text-muted" data-testid="chess-status">{status}</div>
      <div className="flex gap-4 justify-center items-center flex-wrap">
        {LEVELS.map((l) => <Button key={l.n} size="sm" variant={level === l.n ? 'accent' : 'default'} onClick={() => setLevel(l.n)}>{l.label}</Button>)}
        <Button size="sm" onClick={reset}>New game</Button>
      </div>
    </>
  );
}

export function SmPlayVsCrew({ opp }: { opp: string }) {
  const [pick, setPick] = useState<Pick | null>(null);
  const opts: { id: Pick; label: string }[] = [{ id: 'chess', label: 'Chess' }, { id: 'c4', label: 'Connect 4' }, { id: 'ttt', label: 'Tic-tac-toe' }];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex gap-4 justify-center">
        {opts.map((o) => <Button key={o.id} size="sm" variant={pick === o.id ? 'accent' : 'default'} onClick={() => setPick(o.id)}>{o.label}</Button>)}
      </div>
      {!pick && <div className="text-2xs text-text-muted text-center">Pick a game — you play {opp}. No AI, just classic game engines.</div>}
      {pick === 'ttt' && <PlayTtt opp={opp} />}
      {pick === 'c4' && <PlayC4 opp={opp} />}
      {pick === 'chess' && <PlayChess opp={opp} />}
    </div>
  );
}
