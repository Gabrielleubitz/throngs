/**
 * Game Room spectator view — opened from the Game Room's wall sign. Shows the live games the idle
 * crew are playing (board / court, players' names, score). Read-only; state comes from games.ts.
 */
import { useState, useSyncExternalStore } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { type Game, getGames, PADDLE_H, PONG_H, PONG_W, subscribeGames, type TttGame, WIN_SCORE } from './games.js';
import { SmBasketballCourt } from './SmBasketballCourt.js';
import { SmChessBoard } from './SmChessBoard.js';
import { SmPlayVsCrew } from './SmPlayVsCrew.js';

const TITLE: Record<Game['kind'], string> = { pong: 'PONG', tictactoe: 'TIC-TAC-TOE', chess: 'CHESS', basketball: 'BASKETBALL' };

function Scoreboard({ g }: { g: Game }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span style={{ color: 'var(--color-accent-bright)' }}>{g.kind === 'basketball' ? g.hoopers.filter((h) => h.team === 0).map((h) => h.name).join(' & ') : g.players[0].name}{g.kind === 'tictactoe' ? ' (X)' : ''}</span>
      <span className="text-sm">{g.score[0]} : {g.score[1]}</span>
      <span style={{ color: 'var(--color-sm-gold)' }}>{g.kind === 'basketball' ? g.hoopers.filter((h) => h.team === 1).map((h) => h.name).join(' & ') : g.players[1].name}{g.kind === 'tictactoe' ? ' (O)' : ''}</span>
    </div>
  );
}

function Ttt({ g }: { g: TttGame }) {
  const status = g.winner === 'draw' ? "It's a draw!" : g.winner !== null ? `${g.players[g.winner].name} wins!` : `${g.players[g.turn].name} is thinking…`;
  return (
    <>
      <div className="grid grid-cols-3 gap-4 w-[150px] mx-auto">
        {g.board.map((m, i) => (
          <div key={i} className="h-[46px] flex items-center justify-center border-2 border-border bg-bg-dark text-lg"
            style={{ color: m === 'X' ? 'var(--color-accent-bright)' : 'var(--color-sm-gold)' }}>{m}</div>
        ))}
      </div>
      <div className="text-2xs text-center text-text-muted">{status}</div>
    </>
  );
}

function Pong({ g }: { g: Extract<Game, { kind: 'pong' }> }) {
  const over = g.score[0] >= WIN_SCORE || g.score[1] >= WIN_SCORE;
  const status = over ? `${g.players[g.score[0] >= WIN_SCORE ? 0 : 1].name} wins the match!` : `First to ${WIN_SCORE}`;
  return (
    <>
      <svg viewBox={`0 0 ${PONG_W} ${PONG_H}`} className="w-full border-2 border-border bg-bg-dark" style={{ imageRendering: 'pixelated' }}>
        <line x1={PONG_W / 2} y1={0} x2={PONG_W / 2} y2={PONG_H} stroke="var(--color-border)" strokeDasharray="3 3" />
        <rect x={0} y={g.paddles[0] - PADDLE_H / 2} width={2} height={PADDLE_H} fill="var(--color-accent-bright)" />
        <rect x={PONG_W - 2} y={g.paddles[1] - PADDLE_H / 2} width={2} height={PADDLE_H} fill="var(--color-sm-gold)" />
        <rect x={g.ball.x - 1.5} y={g.ball.y - 1.5} width={3} height={3} fill="var(--color-text)" />
      </svg>
      <div className="text-2xs text-center text-text-muted">{status}</div>
    </>
  );
}

export function SmGameRoom({ onClose }: { onClose: () => void }) {
  const games = useSyncExternalStore(subscribeGames, getGames);
  const [tab, setTab] = useState<'watch' | 'play'>('watch');
  const opp = games[0]?.players[0].name ?? 'the crew';
  return (
    <Modal isOpen onClose={onClose} title="Game Room · games" zIndex={63} className="w-[460px]">
      <div className="px-10 pb-8 flex flex-col gap-10 text-text">
        <div className="flex gap-4">
          <Button size="sm" variant={tab === 'watch' ? 'accent' : 'default'} onClick={() => setTab('watch')}>Watch the crew</Button>
          <Button size="sm" variant={tab === 'play' ? 'accent' : 'default'} onClick={() => setTab('play')}>Play against the crew</Button>
        </div>
        {tab === 'play' && <SmPlayVsCrew opp={opp} />}
        {tab === 'watch' && games.length === 0 && (
          <div className="text-2xs text-text-muted">Nobody is playing right now. Games start as soon as two teammates are idle — everyone is busy working.</div>
        )}
        {tab === 'watch' && games.map((g) => (
          <div key={`${g.table}-${g.kind}`} className="border-2 border-border p-8 flex flex-col gap-6">
            <div className="text-2xs text-text-muted">TABLE {g.table} · {TITLE[g.kind]} · watching live</div>
            <Scoreboard g={g} />
            {g.kind === 'pong' && <Pong g={g} />}
            {g.kind === 'tictactoe' && <Ttt g={g} />}
            {g.kind === 'chess' && (<><SmChessBoard chess={g.chess} size={240} /><div className="text-2xs text-center text-text-muted">{g.last}</div></>)}
            {g.kind === 'basketball' && (<><SmBasketballCourt g={g} /><div className="text-2xs text-center text-text-muted">{g.last}</div></>)}
          </div>
        ))}
      </div>
    </Modal>
  );
}
