/** Chess board (unicode pieces). Read-only for the crew's table; `onSquare` makes it playable. */
import type { Chess, Square } from 'chess.js';

import { BLACK, CHESS_DARK, CHESS_DOT, CHESS_LAST, CHESS_LIGHT, CHESS_SELECT, INK, WHITE } from './gameColors.js';

const GLYPH: Record<string, string> = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙', bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟' };

export function SmChessBoard({ chess, selected, targets, last, onSquare, size = 280 }: {
  chess: Chess; selected?: string | null; targets?: string[]; last?: { from: string; to: string } | null; onSquare?: (sq: Square) => void; size?: number;
}) {
  const cell = size / 8;
  return (
    <div className="mx-auto border-2 border-border" style={{ width: size, height: size, display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)' }}>
      {chess.board().flatMap((row, r) => row.map((p, c) => {
        const sq = `${'abcdefgh'[c]}${8 - r}` as Square;
        const dark = (r + c) % 2 === 1;
        const hl = sq === selected ? CHESS_SELECT : last && (sq === last.from || sq === last.to) ? CHESS_LAST : dark ? CHESS_DARK : CHESS_LIGHT;
        return (
          <div key={sq} onClick={onSquare ? () => onSquare(sq) : undefined} data-sq={sq}
            style={{ background: hl, height: cell, fontSize: cell * 0.8, lineHeight: `${cell}px`, textAlign: 'center', cursor: onSquare ? 'pointer' : 'default', position: 'relative', color: p?.color === 'w' ? WHITE : INK, textShadow: p?.color === 'w' ? `0 0 2px ${BLACK}, 0 0 2px ${BLACK}` : 'none' }}>
            {p ? GLYPH[p.color + p.type] : ''}
            {targets?.includes(sq) && <span style={{ position: 'absolute', left: '50%', top: '50%', width: cell * 0.3, height: cell * 0.3, margin: `${-cell * 0.15}px 0 0 ${-cell * 0.15}px`, borderRadius: '50%', background: CHESS_DOT }} />}
          </div>
        );
      }))}
    </div>
  );
}
