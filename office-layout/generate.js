#!/usr/bin/env node
/**
 * Generates the Success Manager office layout (Pixel Agents layout format v1) and prints it as JSON.
 *
 *   ┌──────────┬────────────┬──────────────┬───────────┐
 *   │ YOUR     │ CONTROL    │ ENGINEERING  │ CONFER-   │   top band  (rows 0-9)
 *   │ OFFICE   │ ROOM       │              │ ENCE ROOM │
 *   ├──  ──────┴───  ───────┴─────  ───────┤
 *   │               HALLWAY                │   rows 10-11
 *   ├──  ─────┬──  ─────┬──  ─────┬──  ────┤
 *   │ DESIGN  │ QA LAB  │ MARKET- │ LOUNGE │   bottom band (rows 12-21)
 *   │ LAB     │         │ ING     │        │
 *   ├─────────┴─────────┴─────────┴────────┤
 *   │ ZOO  (animals live here, rows 22-30) │
 *   └──────────────────────────────────────┘
 *   STUDIO (cols 46-57, rows 9-21) sits east of the Game Room, at the end of the hallway: with MUSIC on,
 *   idle crew gather on its dance floor (`sm/throngStudio.ts`) and sing.
 *   RECEPTION (cols 46-57, rows 21-31) sits under the Studio (door in its floor): IVY the secretary's front desk.
 *
 * Crew seats are chairs with fixed uids (`sm-seat-<crewId>`) so the dashboard can seat each crew
 * member in their own room. Idle crew walk to the Game Room (`sm-seat-game-*` chairs) and play watchable games. Your desk has no chair: it holds the report tray (a DOM overlay).
 */
const COLS = 58, ROWS = 32, WALL = 0, VOID = 255;

const WALL_COLOR = { h: 228, s: 22, b: -92, c: -40 };
const ROOMS = [
  // label, color (area overlay), rect [c0, r0, c1, r1] (walls inclusive), floor pattern, floor colour
  { label: 'Your Office', color: '#f2c14e', rect: [0, 0, 10, 9], floor: 7, tint: { h: 32, s: 52, b: -38, c: -80 } },
  { label: 'Control Room', color: '#7dd3fc', rect: [10, 0, 22, 9], floor: 4, tint: { h: 212, s: 30, b: -55, c: -60 } },
  { label: 'Engineering', color: '#22d3ee', rect: [22, 0, 36, 9], floor: 5, tint: { h: 196, s: 26, b: -50, c: -70 } },
  { label: 'Conference Room', color: '#e879f9', rect: [36, 0, 46, 9], floor: 4, tint: { h: 285, s: 22, b: -50, c: -68 } },
  { label: 'Hallway', color: '#94a3b8', rect: [0, 9, 46, 12], floor: 2, tint: { h: 230, s: 10, b: -45, c: -70 } },
  { label: 'Design Lab', color: '#a78bfa', rect: [0, 12, 9, 21], floor: 3, tint: { h: 262, s: 26, b: -48, c: -65 } },
  { label: 'QA Lab', color: '#34d399', rect: [9, 12, 18, 21], floor: 8, tint: { h: 158, s: 18, b: -52, c: -78 } },
  { label: 'Marketing', color: '#fbbf24', rect: [18, 12, 27, 21], floor: 6, tint: { h: 36, s: 34, b: -45, c: -70 } },
  { label: 'Lounge', color: '#fb923c', rect: [27, 12, 36, 21], floor: 1, tint: { h: 18, s: 45, b: -40, c: -75 } },
  { label: 'Zoo', color: '#4ade80', rect: [0, 21, 46, 31], floor: 7, tint: { h: 112, s: 38, b: -48, c: -70 } },
  { label: 'Game Room', color: '#f472b6', rect: [36, 12, 46, 21], floor: 2, tint: { h: 320, s: 35, b: -45, c: -72 } },
  { label: 'Studio', color: '#facc15', rect: [46, 9, 57, 21], floor: 5, tint: { h: 268, s: 40, b: -55, c: -60 } },
  { label: 'Reception', color: '#f9a8d4', rect: [46, 21, 57, 31], floor: 3, tint: { h: 330, s: 30, b: -45, c: -70 } },
];
// door gaps (2 tiles) in the hallway walls
const DOORS = [[4, 9], [5, 9], [15, 9], [16, 9], [28, 9], [29, 9], [40, 9], [41, 9], [6, 12], [7, 12], [13, 12], [14, 12], [22, 12], [23, 12], [31, 12], [32, 12], [41, 12], [42, 12], [46, 10], [46, 11]]; // last two: hallway → Studio

const idx = (c, r) => r * COLS + c;
const tiles = new Array(COLS * ROWS).fill(VOID);
const tileColors = new Array(COLS * ROWS).fill(null);
const areaTiles = new Array(COLS * ROWS).fill(null);

for (const room of ROOMS) {
  const [c0, r0, c1, r1] = room.rect;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const border = r === r0 || r === r1 || c === c0 || c === c1;
      const i = idx(c, r);
      if (border) {
        if (tiles[i] === VOID) { tiles[i] = WALL; tileColors[i] = WALL_COLOR; }
      } else {
        tiles[i] = room.floor; tileColors[i] = { ...room.tint, colorize: true }; areaTiles[i] = room.label;
      }
    }
  }
}
// The hallway's side walls overlap rooms' borders; carve the hallway interior back out and open doors.
for (let r = 10; r <= 11; r++) for (let c = 1; c <= 45; c++) {
  const hall = ROOMS.find((x) => x.label === 'Hallway');
  tiles[idx(c, r)] = hall.floor; tileColors[idx(c, r)] = { ...hall.tint, colorize: true }; areaTiles[idx(c, r)] = 'Hallway';
}
// two-tile door from the QA Lab down into the Zoo (the Zoo's first interior row is 22 = ZOO_FIRST_ROW)
for (const c of [13, 14]) {
  const zoo = ROOMS.find((x) => x.label === 'Zoo');
  tiles[idx(c, 21)] = zoo.floor; tileColors[idx(c, 21)] = { ...zoo.tint, colorize: true }; areaTiles[idx(c, 21)] = 'Zoo';
}
// two-tile door from the Studio down into Reception
for (const c of [51, 52]) {
  const rec = ROOMS.find((x) => x.label === 'Reception');
  tiles[idx(c, 21)] = rec.floor; tileColors[idx(c, 21)] = { ...rec.tint, colorize: true }; areaTiles[idx(c, 21)] = 'Reception';
}
for (const [c, r] of DOORS) {
  const hall = ROOMS.find((x) => x.label === 'Hallway');
  tiles[idx(c, r)] = hall.floor; tileColors[idx(c, r)] = { ...hall.tint, colorize: true }; areaTiles[idx(c, r)] = 'Hallway';
}

let n = 0;
const furniture = [];
const put = (type, col, row, uid) => furniture.push({ uid: uid || `sm-f-${++n}`, type, col, row });
// wall items sit with their footprint's bottom row on the wall row
const onWall = (type, col, wallRow, h) => put(type, col, wallRow - h + 1);
// a workstation: 3×2 desk, PC on its top row, bench below it (the seat, facing the desk)
const workstation = (col, row, seatUid, pcOn = false) => {
  put('DESK_FRONT', col, row);
  put(pcOn ? 'PC_FRONT_ON_1' : 'PC_FRONT_OFF', col + 1, row);
  if (seatUid) put('CUSHIONED_BENCH', col + 1, row + 2, seatUid);
};

// ── Your Office (cols 1-9, rows 1-8) ──
workstation(3, 3, null);                       // your desk — report tray overlay sits on it
onWall('LARGE_PAINTING', 2, 0, 2);
onWall('CLOCK', 6, 0, 2);
onWall('BOOKSHELF', 7, 0, 1);
put('LARGE_PLANT', 7, 5);
put('SOFA_FRONT', 2, 7);
put('POT', 1, 1);

// ── Control Room (cols 11-21) — the floor manager ──
put('TABLE_FRONT', 15, 2);                      // 3×4 strategy table
put('CUSHIONED_BENCH', 16, 6, 'sm-seat-orchestrator');
put('WOODEN_CHAIR_SIDE', 14, 3, 'sm-seat-hire-control-1');
put('WOODEN_CHAIR_SIDE:left', 18, 3, 'sm-seat-hire-control-2');
onWall('WHITEBOARD', 12, 0, 2);
onWall('WHITEBOARD', 19, 0, 2);
put('PLANT', 11, 7);
put('PLANT_2', 21, 7);

// ── Engineering (cols 23-35) — builder + code reviewer ──
workstation(24, 3, 'sm-seat-builder');
workstation(30, 3, 'sm-seat-code');
onWall('DOUBLE_BOOKSHELF', 23, 0, 2);
onWall('SMALL_PAINTING', 28, 0, 2);
onWall('HANGING_PLANT', 34, 0, 2);
put('BIN', 35, 8);
put('CACTUS', 23, 7);
workstation(27, 5, 'sm-seat-hire-engineering-1');   // spare desk for a new hire

// ── Conference Room (cols 37-45, rows 1-8) — meetings: the crew sits round the table (sm-seat-conf-1..10),
// ARES runs it from the head (sm-seat-conf-host) facing the wall TV where the video plays ──
// explicit uids (not sm-f-N) so `merge.js` can add this room to an owner-edited live layout
put('CONFERENCE_TABLE_SIDE', 40, 3, 'sm-conf-table');   // 2×4 table, cols 40-41, rows 3-6
for (let k = 0; k < 4; k++) {
  put('CUSHIONED_CHAIR_SIDE', 39, 3 + k, `sm-seat-conf-${k + 1}`);
  put('CUSHIONED_CHAIR_SIDE:left', 42, 3 + k, `sm-seat-conf-${k + 5}`);
}
put('CUSHIONED_CHAIR_BACK', 40, 7, 'sm-seat-conf-host');
put('CUSHIONED_CHAIR_FRONT', 40, 2, 'sm-seat-conf-9');  // far end of the table, facing the host
put('CUSHIONED_CHAIR_FRONT', 41, 2, 'sm-seat-conf-10');
put('WALL_TV', 40, 0, 'sm-conf-tv');
put('WHITEBOARD', 37, -1, 'sm-conf-board');
put('CLOCK', 44, -1, 'sm-conf-clock');
put('PLANT', 37, 8, 'sm-conf-plant-1');
put('PLANT_2', 45, 8, 'sm-conf-plant-2');

// ── Design Lab (cols 1-8, rows 13-20) — UI + UX ──
workstation(1, 15, 'sm-seat-ui');
workstation(5, 15, 'sm-seat-ux');
onWall('WHITEBOARD', 2, 12, 2);
onWall('SMALL_PAINTING_2', 4, 12, 2);
put('PLANT', 1, 19);
workstation(3, 18, 'sm-seat-hire-design-1');

// ── QA Lab (cols 10-17) — functionality ──
workstation(11, 15, 'sm-seat-functionality');
onWall('DOUBLE_BOOKSHELF', 10, 12, 2);
onWall('CLOCK', 16, 12, 2);
put('SMALL_TABLE_SIDE', 16, 16);
put('CACTUS', 10, 19);
put('BIN', 16, 20);
workstation(11, 18, 'sm-seat-hire-qa-1');

// ── Marketing (cols 19-26) ──
workstation(20, 15, 'sm-seat-marketing');
onWall('LARGE_PAINTING', 19, 12, 2);
onWall('SMALL_PAINTING', 25, 12, 2);
put('SOFA_FRONT', 24, 19);
put('PLANT', 19, 19);
workstation(20, 18, 'sm-seat-hire-marketing-1');
put('DESK_FRONT', 23, 15, 'sm-video-desk');          // REEL, the Video Producer
put('PC_FRONT_OFF', 24, 15, 'sm-video-pc');
put('CUSHIONED_BENCH', 24, 17, 'sm-seat-video');

// ── Lounge (cols 28-35) ──
put('SOFA_FRONT', 30, 14);
put('COFFEE_TABLE', 30, 15);
put('SOFA_BACK', 30, 17);
put('SOFA_SIDE', 29, 15);
put('SOFA_SIDE:left', 32, 15);
put('SMALL_TABLE_FRONT', 34, 14);
put('COFFEE', 34, 14);
put('COFFEE', 35, 14);
onWall('BOOKSHELF', 28, 12, 1);
onWall('LARGE_PAINTING', 33, 12, 2);
put('LARGE_PLANT', 34, 18);
put('WOODEN_BENCH', 28, 20);
put('WOODEN_BENCH', 29, 20);

// ── Game Room (cols 37-45) — two game tables; idle crew sit here and play ──
put('SMALL_TABLE_FRONT', 39, 14);                // table A (tic-tac-toe)
put('WOODEN_CHAIR_SIDE', 38, 14, 'sm-seat-game-1');
put('WOODEN_CHAIR_SIDE:left', 41, 14, 'sm-seat-game-2');
put('SMALL_TABLE_FRONT', 39, 18);                // table B (pong)
put('WOODEN_CHAIR_SIDE', 38, 18, 'sm-seat-game-3');
put('WOODEN_CHAIR_SIDE:left', 41, 18, 'sm-seat-game-4');
onWall('LARGE_PAINTING', 38, 12, 2);
onWall('WHITEBOARD', 43, 12, 2);
put('PLANT', 44, 14);
put('COFFEE_TABLE', 43, 17);
put('BIN', 45, 20);

// ── Studio (cols 47-56, rows 10-20) — music room: stage at the back, the dance floor stays clear ──
// explicit uids so `merge.js` adds it to an owner-edited live layout
put('LAMP', 48, 10, 'sm-studio-lamp-1');               // stage lights (not 47: that blocks the hallway door)
put('LAMP', 56, 10, 'sm-studio-lamp-2');
put('TV_STAND', 51, 10, 'sm-studio-stage');             // the mixing desk
put('WALL_TV', 51, 9, 'sm-studio-screen');
put('POSTER', 48, 8, 'sm-studio-poster-1');
put('POSTER', 55, 8, 'sm-studio-poster-2');
put('BEANBAG', 47, 19, 'sm-studio-beanbag-1');
put('BEANBAG', 56, 19, 'sm-studio-beanbag-2');
put('PLANT', 56, 15, 'sm-studio-plant');

// ── Reception (cols 47-56, rows 22-30) — IVY's front desk. Named uids: `merge.js` adds them to an owner-edited
// layout, and `SmOverlay` hangs IVY's clickable spots on the desk, board, files and shelf by these uids ──
put('DESK_FRONT', 50, 24, 'sm-rec-desk');
put('PC_FRONT_OFF', 51, 24, 'sm-rec-pc');
put('FLOWERS', 50, 24, 'sm-rec-flowers');
put('CUSHIONED_BENCH', 51, 26, 'sm-seat-secretary');
put('WHITEBOARD', 48, 20, 'sm-rec-board');
put('CLOCK', 47, 20, 'sm-rec-clock');
put('BOOKSHELF', 55, 21, 'sm-rec-shelf');
put('FILING_CABINET', 47, 23, 'sm-rec-files');
put('SOFA_FRONT', 48, 28, 'sm-rec-sofa');
put('WATER_COOLER', 56, 27, 'sm-rec-cooler');
put('PLANT', 56, 22, 'sm-rec-plant-1');
put('LARGE_PLANT', 47, 29, 'sm-rec-plant-2');

// ── Zoo (cols 1-45, rows 22-30) — animals live here and never leave; jobs for them come later ──
put('LARGE_PLANT', 1, 22);
put('LARGE_PLANT', 44, 22);
put('PLANT', 2, 29);
put('PLANT_2', 43, 29);
put('CACTUS', 22, 22);
put('BIN', 45, 29);
put('WOODEN_BENCH', 20, 29);
put('WOODEN_BENCH', 21, 29);
put('SMALL_TABLE_FRONT', 11, 26);
put('SMALL_TABLE_FRONT', 28, 27);
put('SMALL_TABLE_FRONT', 34, 26);
// greenery + rocks (pots) to make it read as a zoo: hedge rows along the back wall, tree clumps, rock piles
for (const c of [4, 7, 10, 13, 16, 25, 28, 31, 34, 37, 40]) put(c % 2 ? 'PLANT' : 'PLANT_2', c, 22);
for (const [c, r] of [[3, 25], [4, 26], [41, 24], [42, 25], [8, 28], [15, 24], [37, 28], [30, 24]]) put('POT', c, r);
for (const [c, r] of [[2, 24], [43, 27], [24, 25], [18, 27]]) put('LARGE_PLANT', c, r);
for (const [c, r] of [[6, 29], [39, 29]]) put('CACTUS', c, r);

const layout = {
  version: 1,
  cols: COLS,
  rows: ROWS,
  layoutRevision: 1,
  tiles,
  tileColors,
  furniture,
  pets: [{ id: 'sm-pet-1', petType: 0 }, { id: 'sm-pet-2', petType: 1 },
    // zoo animals: petType is resolved client-side (the last loaded pets); they never leave the Zoo
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => ({ id: `sm-zoo-${k}`, petType: 2 + k }))],
  areas: ROOMS.filter((r) => r.label !== 'Hallway').map(({ label, color }) => ({ label, color })),
  areaTiles: areaTiles.map((a) => (a === 'Hallway' ? null : a)),
};
process.stdout.write(JSON.stringify(layout, null, 2) + '\n');
