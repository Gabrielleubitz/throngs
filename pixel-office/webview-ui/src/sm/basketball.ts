/**
 * Basketball court engine — pure, dependency-free. Idle crew run a real little game: ball handler drives to the
 * hoop, passes, shoots (arc + make/miss), defenders chase and steal, loose balls get rebounded. UI renders `BasketGame`.
 */
export interface HoopPlayer { id: string; name: string; team: 0 | 1; x: number; y: number }
export interface BasketBall {
  x: number; y: number; z: number;
  holder: number; // index into hoopers, -1 = loose or in flight
  flight: null | { fx: number; fy: number; tx: number; ty: number; t: number; T: number; kind: 'shot' | 'pass'; make: boolean; team: 0 | 1; pts: number; to: number };
}
export interface BasketGame {
  kind: 'basketball'; table: number; players: [{ id: string; name: string }, { id: string; name: string }];
  hoopers: HoopPlayer[]; ball: BasketBall; score: [number, number]; pause: number; last: string; tick: number;
}

export const COURT_W = 100, COURT_H = 56, WIN_POINTS = 11;
const PAUSE = 14;
const HOOP: [number, number] = [COURT_W - 6, COURT_H / 2]; // team 0 attacks right, team 1 attacks left
const hoopOf = (team: 0 | 1): [number, number] => (team === 0 ? HOOP : [COURT_W - HOOP[0], HOOP[1]]);
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

export function newBasketGame(table: number, people: { id: string; name: string }[], rand: () => number = Math.random): BasketGame {
  const per = Math.max(1, Math.floor(Math.min(people.length, 4) / 2));
  const hoopers: HoopPlayer[] = [];
  for (let i = 0; i < per * 2; i++) {
    const team = (i % 2) as 0 | 1;
    hoopers.push({ ...people[i], team, x: 30 + 40 * (team === 0 ? 0 : 1) + (rand() - 0.5) * 8, y: 14 + ((i >> 1) + 0.5) * (COURT_H - 28) / per });
  }
  const g: BasketGame = {
    kind: 'basketball', table, players: [{ id: hoopers[0].id, name: hoopers[0].name }, { id: hoopers[1].id, name: hoopers[1].name }],
    hoopers, ball: { x: COURT_W / 2, y: COURT_H / 2, z: 0, holder: -1, flight: null }, score: [0, 0], pause: 0, last: 'Tip-off!', tick: 0,
  };
  return g;
}

function move(h: HoopPlayer, tx: number, ty: number, speed: number, rand: () => number): void {
  const d = dist(h.x, h.y, tx, ty);
  if (d > 0.6) { h.x += ((tx - h.x) / d) * speed + (rand() - 0.5) * 0.25; h.y += ((ty - h.y) / d) * speed + (rand() - 0.5) * 0.25; }
  h.x = Math.max(2, Math.min(COURT_W - 2, h.x)); h.y = Math.max(2, Math.min(COURT_H - 2, h.y));
}

export function basketStep(g: BasketGame, rand: () => number = Math.random): void {
  g.tick++;
  if (g.pause > 0) {
    if (--g.pause === 0 && (g.score[0] >= WIN_POINTS || g.score[1] >= WIN_POINTS)) { g.score = [0, 0]; g.last = 'New game!'; }
    return;
  }
  const b = g.ball, hs = g.hoopers;
  const holder = b.holder >= 0 ? hs[b.holder] : null;

  if (b.flight) {
    const f = b.flight;
    f.t++;
    const p = Math.min(1, f.t / f.T);
    b.x = f.fx + (f.tx - f.fx) * p; b.y = f.fy + (f.ty - f.fy) * p;
    b.z = f.kind === 'shot' ? Math.sin(Math.PI * p) * 16 + 3 * p : Math.sin(Math.PI * p) * 3;
    if (f.t >= f.T) {
      b.flight = null; b.z = 0;
      if (f.kind === 'pass') { b.holder = f.to; b.x = hs[f.to].x; b.y = hs[f.to].y; }
      else if (f.make) {
        g.score[f.team] += f.pts; g.last = `${hs.find((h) => h.team === f.team)?.name ?? ''} team scores ${f.pts}!`;
        g.pause = g.score[f.team] >= WIN_POINTS ? PAUSE * 4 : PAUSE;
        const other = hoopOf(f.team === 0 ? 1 : 0);
        b.x = other[0] + (other[0] < COURT_W / 2 ? 14 : -14); b.y = COURT_H / 2; // inbound near the scorers' opponents
      } else { g.last = 'Miss — rebound!'; b.x = f.tx + (rand() - 0.5) * 10; b.y = f.ty + (rand() - 0.5) * 12; }
    }
  }

  const loose = b.holder < 0 && !b.flight;
  const chaser = loose ? hs.reduce((bi, h, i) => (dist(h.x, h.y, b.x, b.y) < dist(hs[bi].x, hs[bi].y, b.x, b.y) ? i : bi), 0) : -1;
  const guard = holder ? hs.reduce((bi, h, i) => (h.team !== holder.team && (bi < 0 || dist(h.x, h.y, holder.x, holder.y) < dist(hs[bi].x, hs[bi].y, holder.x, holder.y)) ? i : bi), -1) : -1;

  hs.forEach((h, i) => {
    const mates = hs.filter((m) => m.team === h.team);
    const slot = mates.indexOf(h);
    const [hx, hy] = hoopOf(h.team);
    const dir = hx > COURT_W / 2 ? 1 : -1;
    if (loose) { move(h, i === chaser || (loose && h.team !== hs[chaser].team && slot === 0) ? b.x : h.x, i === chaser || (h.team !== hs[chaser].team && slot === 0) ? b.y : h.y, 0.9, rand); return; }
    if (!holder) { move(h, h.x, h.y, 0, rand); return; }
    if (i === b.holder) { move(h, hx - dir * 14, hy + (slot ? 8 : -6), 0.8, rand); return; }
    if (h.team === holder.team) { move(h, hx - dir * (22 + slot * 6), 10 + ((slot * 2 + 1) * (COURT_H - 20)) / (mates.length * 2), 0.6, rand); return; }
    if (i === guard) { move(h, holder.x, holder.y, 0.85, rand); return; }
    move(h, hoopOf(holder.team)[0] - dir * 0 - (hoopOf(holder.team)[0] > COURT_W / 2 ? 10 : -10), hoopOf(holder.team)[1] + (slot - 0.5) * 8, 0.7, rand);
  });

  if (loose) {
    const near = hs.findIndex((h, i) => i === chaser && dist(h.x, h.y, b.x, b.y) < 3);
    if (near >= 0) { b.holder = near; g.last = `${hs[near].name} grabs the ball`; }
    return;
  }
  if (!holder) return;
  b.x = holder.x; b.y = holder.y + Math.abs(Math.sin(g.tick / 2)) * -1.5; b.z = 0;
  const [hx, hy] = hoopOf(holder.team);
  const d = dist(holder.x, holder.y, hx, hy);
  if (guard >= 0 && dist(hs[guard].x, hs[guard].y, holder.x, holder.y) < 4 && rand() < 0.05) { b.holder = guard; g.last = `${hs[guard].name} steals it!`; return; }
  if (d <= 20 && rand() < 0.14) {
    const make = rand() < (d < 12 ? 0.62 : 0.42);
    b.flight = { fx: holder.x, fy: holder.y, tx: hx, ty: hy, t: 0, T: 14, kind: 'shot', make, team: holder.team, pts: d >= 17 ? 3 : 2, to: -1 };
    b.holder = -1; g.last = `${holder.name} shoots…`;
    return;
  }
  const mateIdx = hs.findIndex((m, i) => m.team === holder.team && i !== b.holder);
  if (mateIdx >= 0 && d > 20 && rand() < 0.035) {
    b.flight = { fx: holder.x, fy: holder.y, tx: hs[mateIdx].x, ty: hs[mateIdx].y, t: 0, T: 6, kind: 'pass', make: false, team: holder.team, pts: 0, to: mateIdx };
    b.holder = -1; g.last = `${holder.name} passes to ${hs[mateIdx].name}`;
  }
}
