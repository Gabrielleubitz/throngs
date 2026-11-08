/** Live basketball court (SVG): hardwood, lines, two hoops, players with names, a bouncing / arcing ball. */
import { type BasketGame, COURT_H, COURT_W } from './basketball.js';
import { BALL, BLACK, COURT_LINE, COURT_WOOD, HOOP_RIM, INK, WHITE } from './gameColors.js';

const TEAM_COLOR = ['var(--color-accent-bright)', 'var(--color-sm-gold)'];

export function SmBasketballCourt({ g }: { g: BasketGame }) {
  const b = g.ball;
  return (
    <svg viewBox={`-2 -2 ${COURT_W + 4} ${COURT_H + 4}`} className="w-full border-2 border-border" style={{ background: COURT_WOOD, imageRendering: 'pixelated' }}>
      <g stroke={COURT_LINE} strokeWidth={0.5} fill="none" opacity={0.85}>
        <rect x={0} y={0} width={COURT_W} height={COURT_H} />
        <line x1={COURT_W / 2} y1={0} x2={COURT_W / 2} y2={COURT_H} />
        <circle cx={COURT_W / 2} cy={COURT_H / 2} r={7} />
        <rect x={0} y={COURT_H / 2 - 9} width={19} height={18} />
        <rect x={COURT_W - 19} y={COURT_H / 2 - 9} width={19} height={18} />
        <path d={`M 0 ${COURT_H / 2 - 22} H 10 A 24 24 0 0 1 10 ${COURT_H / 2 + 22} H 0`} />
        <path d={`M ${COURT_W} ${COURT_H / 2 - 22} H ${COURT_W - 10} A 24 24 0 0 0 ${COURT_W - 10} ${COURT_H / 2 + 22} H ${COURT_W}`} />
      </g>
      {[6, COURT_W - 6].map((x) => <circle key={x} cx={x} cy={COURT_H / 2} r={1.8} fill="none" stroke={HOOP_RIM} strokeWidth={0.7} />)}
      {g.hoopers.map((h) => (
        <g key={h.id}>
          <ellipse cx={h.x} cy={h.y + 3} rx={2.6} ry={0.9} fill={BLACK} opacity={0.3} />
          <circle cx={h.x} cy={h.y} r={2.6} fill={TEAM_COLOR[h.team]} stroke={INK} strokeWidth={0.5} />
          <text x={h.x} y={h.y + 1} fontSize={3} textAnchor="middle" fill={INK} fontWeight="bold">{h.name.slice(0, 1)}</text>
          <text x={h.x} y={h.y - 3.4} fontSize={2.6} textAnchor="middle" fill={WHITE} stroke={INK} strokeWidth={0.4} paintOrder="stroke">{h.name}</text>
        </g>
      ))}
      <ellipse cx={b.x} cy={b.y + 1} rx={1.1} ry={0.4} fill={BLACK} opacity={0.35} />
      <circle cx={b.x} cy={b.y - b.z} r={1.4} fill={BALL} stroke={INK} strokeWidth={0.35} />
    </svg>
  );
}
