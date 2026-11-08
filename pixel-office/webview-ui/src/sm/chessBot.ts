/**
 * Chess for the office: rules via chess.js, the bot is js-chess-engine (MIT, github.com/josefjadrny/js-chess-engine).
 * Used for both the idle crew's chess table and the owner's "play chess vs the crew" board.
 */
import { Chess } from 'chess.js';
import { aiMove } from 'js-chess-engine';

/** Ask the engine (level 1–4) for a reply move on `chess`; returns the applied chess.js move or null at game end. */
export function chessBotMove(chess: Chess, level: number): { from: string; to: string; san: string } | null {
  if (chess.isGameOver()) return null;
  try {
    const m = aiMove(chess.fen(), Math.max(1, Math.min(5, level)));
    const from = Object.keys(m)[0].toLowerCase(), to = Object.values(m)[0].toLowerCase();
    const r = chess.move({ from, to, promotion: 'q' });
    return { from: r.from, to: r.to, san: r.san };
  } catch {
    const legal = chess.moves({ verbose: true });
    if (!legal.length) return null;
    const m = legal[Math.floor(Math.random() * legal.length)];
    const r = chess.move(m);
    return { from: r.from, to: r.to, san: r.san };
  }
}

export function chessStatus(chess: Chess): string | null {
  if (chess.isCheckmate()) return `Checkmate — ${chess.turn() === 'w' ? 'Black' : 'White'} wins`;
  if (chess.isStalemate()) return 'Stalemate';
  if (chess.isDraw()) return 'Draw';
  return null;
}
