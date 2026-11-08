/* =====================================================================================
   PIXEL OFFICE — tile renderer for the ARES-I dashboard.
   Art: Pixel Agents (MIT, github.com/pixel-agents-hq/pixel-agents); characters based on
   JIK-A-4's Metro City pack. Loaded at runtime from the user's own install via /px/*.
   Exposes the same contract the dashboard used before: ROOMS (px rects + name/short/icon),
   crew[], roomAt(agent), focus(rect), OVERVIEW, pick(world), frame loop, overrides.
   ===================================================================================== */
const T = 16, COLS = 44, ROWS = 30, WALL = 0, VOID = 255;
const PX = '/px/';

/* ---------- rooms (tile rects are inclusive wall borders) ---------- */
const ROOM_DEFS = {
  engineering: { name: 'ENGINEERING & SECURITY', short: 'Engineering', icon: 'cpu', tr: [0, 0, 14, 14], floor: 5, tint: { h: 205, s: 22, b: -62, c: -55 }, accent: '#22d3ee', spec: 'BAY-01 · build forge + security console' },
  control: { name: 'CENTRAL CONTROL DECK', short: 'Control', icon: 'crown', tr: [14, 0, 29, 9], floor: 4, tint: { h: 215, s: 25, b: -70, c: -50 }, accent: '#7dd3fc', spec: 'CMD-00 · orchestration core' },
  design: { name: 'UI / UX DESIGN LAB', short: 'Design Lab', icon: 'palette', tr: [29, 0, 43, 14], floor: 3, tint: { h: 262, s: 22, b: -60, c: -55 }, accent: '#a78bfa', spec: 'BAY-02 · holo drafting' },
  qa: { name: 'QA & LOGIC TESTING', short: 'QA Cell', icon: 'flask-conical', tr: [0, 14, 14, 29], floor: 8, tint: { h: 160, s: 20, b: -66, c: -70 }, accent: '#34d399', spec: 'BAY-03 · sim chamber' },
  marketing: { name: 'MARKETING & COPY', short: 'Marketing', icon: 'megaphone', tr: [29, 14, 43, 29], floor: 7, tint: { h: 35, s: 30, b: -58, c: -55 }, accent: '#fbbf24', spec: 'BAY-04 · broadcast array' },
  lounge: { name: 'CREW BREAK LOUNGE', short: 'Lounge', icon: 'coffee', tr: [14, 9, 29, 29], floor: 6, tint: { h: 22, s: 38, b: -55, c: -55 }, accent: '#fb923c', spec: 'BAY-05 · coffee + arcade' },
};
const ROOMS = Object.fromEntries(Object.entries(ROOM_DEFS).map(([k, r]) => {
  const [c0, r0, c1, r1] = r.tr;
  return [k, { ...r, color: r.accent, x: c0 * T, y: r0 * T, w: (c1 - c0 + 1) * T, h: (r1 - r0 + 1) * T }];
}));
const OVERVIEW = { x: 0, y: -16, w: COLS * T, h: ROWS * T + 16 };

const tiles = new Uint8Array(COLS * ROWS).fill(VOID);
const tileRoom = new Array(COLS * ROWS).fill(null);
const idx = (c, r) => r * COLS + c;
for (const [k, r] of Object.entries(ROOM_DEFS)) {
  const [c0, r0, c1, r1] = r.tr;
  for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) {
    const border = y === r0 || y === r1 || x === c0 || x === c1;
    if (border) { if (tiles[idx(x, y)] === VOID) tiles[idx(x, y)] = WALL; }
    else { tiles[idx(x, y)] = r.floor; tileRoom[idx(x, y)] = k; }
  }
}
// doors (2 tiles) into the lounge / corridor
for (const [c, r, room] of [[14, 11, 'lounge'], [14, 12, 'lounge'], [29, 11, 'lounge'], [29, 12, 'lounge'], [14, 21, 'lounge'], [14, 22, 'lounge'], [29, 21, 'lounge'], [29, 22, 'lounge'], [21, 9, 'lounge'], [22, 9, 'lounge']]) {
  tiles[idx(c, r)] = ROOM_DEFS[room].floor; tileRoom[idx(c, r)] = room;
}

/* ---------- furniture ---------- */
// [sprite path, col, row, footprintW, footprintH, opts]
const F = [];
const put = (src, col, row, fw, fh, o = {}) => F.push({ src, col, row, fw, fh, ...o });
const DESKS = {
  code: { desk: [3, 3], seat: [4, 5], mode: 'reading' }, builder: { desk: [9, 3], seat: [10, 5], mode: 'typing' },
  ui: { desk: [32, 3], seat: [33, 5], mode: 'reading' }, ux: { desk: [38, 3], seat: [39, 5], mode: 'reading' },
  functionality: { desk: [5, 18], seat: [6, 20], mode: 'reading' }, marketing: { desk: [35, 18], seat: [36, 20], mode: 'reading' },
  orchestrator: { desk: null, seat: [21, 7], mode: 'typing' },
};
for (const [id, d] of Object.entries(DESKS)) {
  if (!d.desk) continue;
  put('furniture/DESK/DESK_FRONT.png', d.desk[0], d.desk[1], 3, 2, { w: 48, h: 32 });
  put('pc', d.desk[0] + 1, d.desk[1], 1, 1, { pcOf: id, w: 16, h: 32, onSurface: true, z: 2 });
  put('furniture/WOODEN_CHAIR/WOODEN_CHAIR_BACK.png', d.seat[0], d.seat[1], 1, 1, { w: 16, h: 32, seat: true, z: 3 });
}
// control deck
put('furniture/TABLE_FRONT/TABLE_FRONT.png', 20, 3, 3, 4, { w: 48, h: 64 });
put('furniture/WOODEN_CHAIR/WOODEN_CHAIR_BACK.png', 21, 7, 1, 1, { w: 16, h: 32, seat: true, z: 3 });
put('furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png', 19, 4, 1, 1, { w: 16, h: 32 });
put('furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png', 23, 4, 1, 1, { w: 16, h: 32, flip: true });
put('furniture/WHITEBOARD/WHITEBOARD.png', 25, 0, 2, 1, { w: 32, h: 32, wall: true, statusBoard: true });
put('furniture/LARGE_PAINTING/LARGE_PAINTING.png', 16, 0, 2, 1, { w: 32, h: 32, wall: true });
put('furniture/CLOCK/CLOCK.png', 23, 0, 1, 1, { w: 16, h: 32, wall: true });
put('furniture/LARGE_PLANT/LARGE_PLANT.png', 15, 6, 2, 2, { w: 32, h: 48 });
put('furniture/PLANT/PLANT.png', 27, 7, 1, 1, { w: 16, h: 32 });
// engineering
put('furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png', 1, 0, 2, 1, { w: 32, h: 32, wall: true });
put('furniture/BOOKSHELF/BOOKSHELF.png', 6, 0, 2, 1, { w: 32, h: 16, wall: true, dy: 6 });
put('furniture/CLOCK/CLOCK.png', 12, 0, 1, 1, { w: 16, h: 32, wall: true });
put('furniture/BIN/BIN.png', 13, 5, 1, 1, { w: 16, h: 16 });
put('furniture/PLANT_2/PLANT_2.png', 1, 12, 1, 1, { w: 16, h: 32 });
put('furniture/SMALL_TABLE/SMALL_TABLE_FRONT.png', 4, 9, 2, 2, { w: 32, h: 32 });
put('furniture/CACTUS/CACTUS.png', 12, 12, 1, 1, { w: 16, h: 32 });
// design lab
put('furniture/WHITEBOARD/WHITEBOARD.png', 35, 0, 2, 1, { w: 32, h: 32, wall: true });
put('furniture/SMALL_PAINTING/SMALL_PAINTING.png', 31, 0, 1, 1, { w: 16, h: 32, wall: true });
put('furniture/SMALL_PAINTING_2/SMALL_PAINTING_2.png', 41, 0, 1, 1, { w: 16, h: 32, wall: true });
put('furniture/LARGE_PLANT/LARGE_PLANT.png', 41, 11, 2, 2, { w: 32, h: 48 });
put('furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png', 34, 10, 1, 1, { w: 16, h: 16 });
put('furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png', 36, 10, 1, 1, { w: 16, h: 16 });
put('furniture/COFFEE_TABLE/COFFEE_TABLE.png', 34, 11, 2, 2, { w: 32, h: 32 });
// qa
put('furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png', 2, 14, 2, 1, { w: 32, h: 32, wall: true });
put('furniture/WHITEBOARD/WHITEBOARD.png', 8, 14, 2, 1, { w: 32, h: 32, wall: true });
put('furniture/SMALL_TABLE/SMALL_TABLE_SIDE.png', 11, 17, 1, 3, { w: 16, h: 48 });
put('furniture/POT/POT.png', 1, 27, 1, 1, { w: 16, h: 16 });
put('furniture/CACTUS/CACTUS.png', 12, 27, 1, 1, { w: 16, h: 32 });
put('furniture/HANGING_PLANT/HANGING_PLANT.png', 12, 14, 1, 1, { w: 16, h: 32, wall: true });
// marketing
put('furniture/LARGE_PAINTING/LARGE_PAINTING.png', 31, 14, 2, 1, { w: 32, h: 32, wall: true });
put('furniture/SMALL_PAINTING_2/SMALL_PAINTING_2.png', 39, 14, 1, 1, { w: 16, h: 32, wall: true });
put('furniture/HANGING_PLANT/HANGING_PLANT.png', 41, 14, 1, 1, { w: 16, h: 32, wall: true });
put('furniture/SOFA/SOFA_FRONT.png', 39, 24, 2, 1, { w: 32, h: 16 });
put('furniture/PLANT/PLANT.png', 42, 27, 1, 1, { w: 16, h: 32 });
put('furniture/PLANT_2/PLANT_2.png', 30, 27, 1, 1, { w: 16, h: 32 });
// lounge
put('furniture/SOFA/SOFA_FRONT.png', 20, 16, 2, 1, { w: 32, h: 16 });
put('furniture/SOFA/SOFA_FRONT.png', 22, 16, 2, 1, { w: 32, h: 16 });
put('furniture/COFFEE_TABLE/COFFEE_TABLE.png', 21, 18, 2, 2, { w: 32, h: 32 });
put('furniture/SOFA/SOFA_BACK.png', 20, 21, 2, 1, { w: 32, h: 16 });
put('furniture/SOFA/SOFA_BACK.png', 22, 21, 2, 1, { w: 32, h: 16 });
put('furniture/SMALL_TABLE/SMALL_TABLE_FRONT.png', 15, 25, 2, 2, { w: 32, h: 32 });
put('furniture/COFFEE/COFFEE.png', 15, 25, 1, 1, { w: 16, h: 16, onSurface: true, z: 2, dy: -4 });
put('furniture/COFFEE/COFFEE.png', 16, 25, 1, 1, { w: 16, h: 16, onSurface: true, z: 2, dy: -4 });
put('furniture/BOOKSHELF/BOOKSHELF.png', 25, 9, 2, 1, { w: 32, h: 16, wall: true, dy: 6 });
put('furniture/LARGE_PLANT/LARGE_PLANT.png', 26, 26, 2, 2, { w: 32, h: 48 });
put('furniture/PLANT/PLANT.png', 15, 10, 1, 1, { w: 16, h: 32 });
put('furniture/CUSHIONED_BENCH/CUSHIONED_BENCH.png', 18, 27, 1, 1, { w: 16, h: 16 });
put('furniture/CUSHIONED_BENCH/CUSHIONED_BENCH.png', 19, 27, 1, 1, { w: 16, h: 16 });
put('furniture/WOODEN_BENCH/WOODEN_BENCH.png', 24, 27, 1, 1, { w: 16, h: 16 });
put('furniture/BIN/BIN.png', 27, 12, 1, 1, { w: 16, h: 16 });

const LOUNGE_SPOTS = [
  { c: 21, r: 15, act: 'couch', dir: 'DOWN' }, { c: 23, r: 15, act: 'couch', dir: 'DOWN' }, { c: 17, r: 24, act: 'coffee', dir: 'UP' },
  { c: 21, r: 22, act: 'couch', dir: 'UP' }, { c: 18, r: 13, act: 'window', dir: 'DOWN' }, { c: 25, r: 23, act: 'chat', dir: 'LEFT' }, { c: 24, r: 13, act: 'plants', dir: 'DOWN' },
];

/* ---------- walkability ---------- */
const blocked = new Uint8Array(COLS * ROWS);
for (let i = 0; i < tiles.length; i++) if (tiles[i] === WALL || tiles[i] === VOID) blocked[i] = 1;
for (const f of F) {
  if (f.wall || f.onSurface || f.seat) continue;
  for (let y = 0; y < f.fh; y++) for (let x = 0; x < f.fw; x++) blocked[idx(f.col + x, f.row + y)] = 1;
}
function bfs(from, to) {
  const start = idx(from.c, from.r), goal = idx(to.c, to.r);
  if (start === goal) return [];
  const prev = new Int32Array(COLS * ROWS).fill(-1); prev[start] = start;
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    if (cur === goal) break;
    const c = cur % COLS, r = (cur / COLS) | 0;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const n = idx(nc, nr);
      if (prev[n] !== -1 || (blocked[n] && n !== goal)) continue;
      prev[n] = cur; q.push(n);
    }
  }
  if (prev[goal] === -1) return null;
  const path = [];
  for (let n = goal; n !== start; n = prev[n]) path.push({ c: n % COLS, r: (n / COLS) | 0 });
  return path.reverse();
}
const loungeTiles = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (tileRoom[idx(c, r)] === 'lounge' && !blocked[idx(c, r)]) loungeTiles.push({ c, r });

/* ---------- image loading + colorize ---------- */
const IMG = {};
function load(src) { return IMG[src] ||= new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(src)); i.src = PX + src; }); }
function rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2; if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; } return [h, s, l]; }
function hsl2rgb(h, s, l) { h = ((h % 360) + 360) % 360 / 360; if (!s) return [l * 255, l * 255, l * 255]; const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]; }
function recolor(img, fn) {
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, cv.width, cv.height), p = d.data;
  for (let i = 0; i < p.length; i += 4) { if (!p[i + 3]) continue; const o = fn(p[i], p[i + 1], p[i + 2]); p[i] = o[0]; p[i + 1] = o[1]; p[i + 2] = o[2]; }
  x.putImageData(d, 0, 0); return cv;
}
const colorize = (img, { h, s, b, c }) => recolor(img, (r, g, bl) => {
  let L = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
  if (c) L = 0.5 + (L - 0.5) * (100 + c) / 100;
  L = Math.max(0, Math.min(1, L + b / 200));
  return hsl2rgb(h, s / 100, L);
});
const hueShift = (img, deg) => recolor(img, (r, g, b) => { const [h, s, l] = rgb2hsl(r, g, b); return hsl2rgb(h + deg, s, l); });

/* ---------- crew sprites ---------- */
const SPRITE = { orchestrator: [0, 0], builder: [1, 0], code: [2, 0], ui: [3, 0], ux: [4, 0], functionality: [5, 0], marketing: [2, 150] };
const DIR_ROW = { DOWN: 0, UP: 1, RIGHT: 2, LEFT: 2 };
const SHEETS = {};
let floorTiles = {}, wallSheet = null, pets = {}, pcFrames = {}, furnImgs = {};
let assetsReady = false, assetsError = null;

async function loadAssets() {
  try {
    const floorsNeeded = [...new Set(Object.values(ROOM_DEFS).map((r) => r.floor))];
    await Promise.all([
      ...floorsNeeded.map(async (n) => {
        const img = await load(`floors/floor_${n - 1}.png`);
        for (const [k, r] of Object.entries(ROOM_DEFS)) if (r.floor === n) floorTiles[k] = colorize(img, r.tint);
      }),
      load('walls/wall_0.png').then((img) => { wallSheet = colorize(img, { h: 228, s: 16, b: -112, c: 10 }); }),
      ...Object.entries(SPRITE).map(async ([id, [n, hue]]) => { const img = await load(`characters/char_${n}.png`); SHEETS[id] = hue ? hueShift(img, hue) : img; }),
      ...['claudio', 'gitcat'].map(async (p) => { pets[p] = await load(`pets/${p}/pet.png`); }),
      ...['PC_FRONT_OFF', 'PC_FRONT_ON_1', 'PC_FRONT_ON_2', 'PC_FRONT_ON_3'].map(async (k) => { pcFrames[k] = await load(`furniture/PC/${k}.png`); }),
      ...[...new Set(F.filter((f) => f.src !== 'pc').map((f) => f.src))].map(async (s) => { furnImgs[s] = await load(s); }),
      load('carpets/carpet_1.png').then((img) => { floorTiles.carpetLounge = colorize(img, { h: 15, s: 45, b: -20, c: -20 }); }),
      load('carpets/carpet_2.png').then((img) => { floorTiles.carpetControl = colorize(img, { h: 210, s: 40, b: -10, c: -10 }); }),
    ]);
    assetsReady = true;
  } catch (e) {
    assetsError = e;
    console.warn('[office] Pixel Agents assets unavailable — is `pixel-agents` installed and is this served by `sm dashboard`?', e.message);
  }
}
loadAssets();

/* ---------- crew bodies ---------- */
const crew = ORDER.map((id, i) => {
  const spot = LOUNGE_SPOTS[i % LOUNGE_SPOTS.length];
  return { id, c: spot.c, r: spot.r, x: spot.c * T + 8, y: spot.r * T + 15, path: [], dir: 'DOWN', state: 'IDLE', task: '', override: null, spot, dest: null, anim: 0, wanderAt: 0 };
});
const PETS = [
  { id: 'gitcat', c: 18, r: 19, x: 18 * T + 8, y: 19 * T + 15, path: [], dir: 'RIGHT', nextAt: 0 },
  { id: 'claudio', c: 25, r: 18, x: 25 * T + 8, y: 18 * T + 15, path: [], dir: 'LEFT', nextAt: 0 },
];
function roomAt(a) { return tileRoom[idx(Math.round((a.x - 8) / T), Math.round((a.y - 15) / T))] || null; }
function desired(a) {
  let mode = a.state === 'IDLE' ? 'lounge' : 'work';
  if (a.override && performance.now() < a.override.until) mode = a.override.mode; else a.override = null;
  if (mode === 'work') {
    const s = DESKS[a.id].seat;
    // blocked: stand up beside the chair, face the room and wave for a human
    return a.state === 'BLOCKED' ? { c: s[0] + 1, r: s[1], act: 'blocked', dir: 'DOWN' } : { c: s[0], r: s[1], act: 'desk', dir: 'UP' };
  }
  if (performance.now() > a.wanderAt) {
    a.wanderAt = performance.now() + 9000 + Math.random() * 14000;
    a.spot = Math.random() < 0.65 ? LOUNGE_SPOTS[(ORDER.indexOf(a.id) + Math.floor(Math.random() * 3)) % LOUNGE_SPOTS.length] : { ...loungeTiles[Math.floor(Math.random() * loungeTiles.length)], act: 'stroll', dir: 'DOWN' };
  }
  return { c: a.spot.c, r: a.spot.r, act: a.spot.act, dir: a.spot.dir };
}
function syncCrew() {
  for (const a of crew) {
    const d = app.data.agents.find((x) => x.id === a.id);
    if (d) { if (d.state !== a.state && d.state === 'BLOCKED') sfx.alert(); a.state = d.state; a.task = d.task; }
    const s = $(`[data-crew-state="${a.id}"]`);
    if (s) { s.textContent = a.state; s.style.color = a.state === 'WORKING' ? '#6ee7b7' : a.state === 'BLOCKED' ? '#fca5a5' : '#64748b'; }
  }
}
function step(body, dt, speed) {
  const wp = body.path[0];
  if (!wp) return false;
  const tx = wp.c * T + 8, ty = wp.r * T + 15, dx = tx - body.x, dy = ty - body.y, d = Math.hypot(dx, dy), s = speed * dt;
  if (Math.abs(dx) > Math.abs(dy)) body.dir = dx > 0 ? 'RIGHT' : 'LEFT'; else if (dy) body.dir = dy > 0 ? 'DOWN' : 'UP';
  if (d <= s) { body.x = tx; body.y = ty; body.c = wp.c; body.r = wp.r; body.path.shift(); } else { body.x += (dx / d) * s; body.y += (dy / d) * s; }
  return true;
}
function updateCrew(dt) {
  for (const a of crew) {
    const t = desired(a);
    if (!a.dest || a.dest.c !== t.c || a.dest.r !== t.r) {
      const from = { c: Math.round((a.x - 8) / T), r: Math.round((a.y - 15) / T) };
      a.path = bfs(from, t) || []; a.dest = t;
    }
    a.dest.act = t.act; a.dest.dir = t.dir;
    a.walking = step(a, dt, 52);
    if (!a.walking) a.dir = a.dest.dir || 'DOWN';
    a.anim += dt;
  }
  for (const p of PETS) {
    if (!p.path.length && performance.now() > p.nextAt) {
      const to = loungeTiles[Math.floor(Math.random() * loungeTiles.length)];
      p.path = bfs({ c: p.c, r: p.r }, to) || []; p.nextAt = performance.now() + 4000 + Math.random() * 9000;
    }
    p.walking = step(p, dt, 30);
  }
}

/* ---------- camera ---------- */
const cv = $('#viewport'), ctx = cv.getContext('2d');
let vw = 0, vh = 0, dpr = 1;
const cam = { x: COLS * T / 2, y: ROWS * T / 2, z: 2, tx: COLS * T / 2, ty: ROWS * T / 2, tz: 2 };
function resize() { const r = cv.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1); vw = r.width; vh = r.height; cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr); }
new ResizeObserver(resize).observe(cv);
const toWorld = (sx, sy) => ({ x: (sx - vw / 2) / cam.z + cam.x, y: (sy - vh / 2) / cam.z + cam.y });
function focus(rect, pad = 24) {
  cam.tx = rect.x + rect.w / 2; cam.ty = rect.y + rect.h / 2;
  cam.tz = Math.max(1, Math.min(8, Math.min(vw / (rect.w + pad * 2), vh / (rect.h + pad * 2))));
}

/* quick nav + legend + controls */
$('#quickNav').innerHTML = [['overview', 'Overview', 'map'], ...Object.entries(ROOMS).map(([k, r]) => [k, r.short, r.icon])]
  .map(([k, label, ic]) => `<button class="btn shrink-0 !px-2.5 !py-1.5 text-[11px]" data-nav="${k}"><i data-lucide="${ic}" class="h-3.5 w-3.5"></i><span class="hidden sm:inline">${label}</span></button>`).join('');
$('#quickNav').addEventListener('click', (e) => { const b = e.target.closest('[data-nav]'); if (!b) return; sfx.click(); focus(b.dataset.nav === 'overview' ? OVERVIEW : ROOMS[b.dataset.nav]); });
$('#legend').innerHTML = ORDER.map((id) => `<button class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] hover:bg-white/5" data-crew="${id}"><span class="h-2.5 w-2.5 rounded-full" style="background:${CREW[id].color};box-shadow:0 0 8px ${CREW[id].color}"></span><span class="font-mono text-slate-300">${CREW[id].name}</span><span data-crew-state="${id}" class="font-mono text-[9px] text-slate-500"></span></button>`).join('');
$('#legend').addEventListener('click', (e) => { const b = e.target.closest('[data-crew]'); if (!b) return; sfx.open(); const a = crew.find((x) => x.id === b.dataset.crew); if (a) { cam.tx = a.x; cam.ty = a.y - 16; cam.tz = 5; } if (app.data) agentModal(b.dataset.crew); });
$('#zoomIn').onclick = () => { sfx.click(); cam.tz = Math.min(8, cam.tz * 1.25); };
$('#zoomOut').onclick = () => { sfx.click(); cam.tz = Math.max(1, cam.tz / 1.25); };
$('#xrayBtn').onclick = (e) => { app.xray = !app.xray; e.currentTarget.setAttribute('aria-pressed', app.xray); e.currentTarget.classList.toggle('btn-cyan', app.xray); sfx.click(); };

let drag = null;
cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cx: cam.tx, cy: cam.ty, moved: false }; });
cv.addEventListener('pointermove', (e) => {
  const r = cv.getBoundingClientRect();
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; cv.classList.add('dragging'); }
    cam.tx = drag.cx - dx / cam.z; cam.ty = drag.cy - dy / cam.z; cam.x = cam.tx; cam.y = cam.ty;
  } else {
    const w = toWorld(e.clientX - r.left, e.clientY - r.top);
    app.hoverAgent = pick(w);
    app.hoverRoom = app.hoverAgent ? null : tileRoom[idx(Math.floor(w.x / T), Math.floor(w.y / T))] || null;
    cv.classList.toggle('hovering', Boolean(app.hoverAgent || app.hoverRoom));
  }
});
cv.addEventListener('pointerup', (e) => {
  cv.classList.remove('dragging');
  if (drag && !drag.moved) {
    const r = cv.getBoundingClientRect(), w = toWorld(e.clientX - r.left, e.clientY - r.top);
    const a = pick(w);
    if (a && app.data) { sfx.open(); agentModal(a.id); }
    else { const room = tileRoom[idx(Math.floor(w.x / T), Math.floor(w.y / T))]; if (room) { sfx.click(); focus(ROOMS[room]); } }
  }
  drag = null;
});
cv.addEventListener('pointerleave', () => { app.hoverAgent = null; app.hoverRoom = null; });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  const before = { x: (sx - vw / 2) / cam.tz + cam.tx, y: (sy - vh / 2) / cam.tz + cam.ty };
  cam.tz = Math.max(1, Math.min(8, cam.tz * Math.exp(-e.deltaY * 0.0015)));
  cam.tx = before.x - (sx - vw / 2) / cam.tz; cam.ty = before.y - (sy - vh / 2) / cam.tz;
}, { passive: false });
function pick(w) {
  let best = null, bd = 13;
  for (const a of crew) { const d = Math.hypot(a.x - w.x, a.y - 12 - w.y); if (d < bd) { bd = d; best = a; } }
  return best;
}

/* ---------- drawing ---------- */
const WALL_MASK_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
function isWall(c, r) { return c >= 0 && r >= 0 && c < COLS && r < ROWS && tiles[idx(c, r)] === WALL; }
function wallPiece(c, r) {
  const m = (isWall(c, r - 1) ? 1 : 0) | (isWall(c + 1, r) ? 2 : 0) | (isWall(c, r + 1) ? 4 : 0) | (isWall(c - 1, r) ? 8 : 0);
  const k = WALL_MASK_ORDER[m];
  return { sx: (k % 4) * 16, sy: Math.floor(k / 4) * 32 };
}
function drawFloor() {
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const room = tileRoom[idx(c, r)];
    if (room && floorTiles[room]) ctx.drawImage(floorTiles[room], c * T, r * T);
  }
  // carpets
  const rug = (img, c0, r0, cw, rh) => { if (!img) return; for (let y = 0; y < rh; y += 4) for (let x = 0; x < cw; x += 4) ctx.drawImage(img, 0, 0, Math.min(4, cw - x) * 16, Math.min(4, rh - y) * 16, (c0 + x) * T, (r0 + y) * T, Math.min(4, cw - x) * T, Math.min(4, rh - y) * T); };
}
function sprite(img, sx, sy, sw, sh, dx, dy, flip) {
  if (!flip) { ctx.drawImage(img, sx, sy, sw, sh, Math.round(dx), Math.round(dy), sw, sh); return; }
  ctx.save(); ctx.translate(Math.round(dx) + sw, Math.round(dy)); ctx.scale(-1, 1); ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh); ctx.restore();
}
function drawables(t) {
  const list = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (tiles[idx(c, r)] === WALL) list.push({ z: (r + 1) * T, fn: () => { const p = wallPiece(c, r); ctx.drawImage(wallSheet, p.sx, p.sy, 16, 32, c * T, r * T - 16, 16, 32); } });
  for (const f of F) {
    const baseZ = (f.row + f.fh) * T + (f.wall ? 0.5 : 0) + (f.z || 0);
    list.push({ z: f.seat ? (f.row + 1) * T + 2 : baseZ, fn: () => {
      let img = furnImgs[f.src];
      if (f.src === 'pc') {
        const owner = crew.find((a) => a.id === f.pcOf);
        img = owner?.state === 'WORKING' && !owner.walking ? pcFrames[`PC_FRONT_ON_${1 + (Math.floor(t * 4) % 3)}`] : owner?.state === 'BLOCKED' ? pcFrames.PC_FRONT_ON_1 : pcFrames.PC_FRONT_OFF;
        if (!img) return;
        ctx.drawImage(img, f.col * T, f.row * T - 9);
        if (owner?.state === 'BLOCKED' && Math.floor(t * 3) % 2) { ctx.fillStyle = 'rgba(248,113,113,.55)'; ctx.fillRect(f.col * T + 2, f.row * T - 6, 12, 9); }
        return;
      }
      if (!img) return;
      const y = f.wall ? f.row * T - 16 + (32 - f.h) / 2 + (f.dy || 0) : (f.row + f.fh) * T - f.h + (f.dy || 0);
      sprite(img, 0, 0, f.w, f.h, f.col * T, y, f.flip);
      if (f.statusBoard && app.data) drawStatusBoard(f, y);
    } });
  }
  for (const a of crew) list.push({ z: a.y + 0.1, fn: () => drawAgent(a, t) });
  for (const p of PETS) list.push({ z: p.y, fn: () => drawPet(p, t) });
  return list.sort((p, q) => p.z - q.z);
}
function drawStatusBoard(f, y) {
  const st = app.data.status, col = st === 'PRODUCTION_READY' ? '#16a34a' : st === 'AWAITING_HUMAN_INPUT' ? '#d97706' : '#0891b2';
  ctx.fillStyle = col; ctx.fillRect(f.col * T + 4, y + 7, 24, 3);
  ctx.font = '5px FSPixel'; ctx.textAlign = 'center'; ctx.fillStyle = '#1e293b';
  const q = app.data.tasks;
  ctx.fillText(`${q.required.length}Q ${q.human.length}H`, f.col * T + 16, y + 17);
}
function drawAgent(a, t) {
  const sheet = SHEETS[a.id]; if (!sheet) return;
  const act = !a.walking && a.dest ? a.dest.act : null;
  const seated = act === 'desk' || act === 'couch';
  let frame;
  if (a.walking) frame = [0, 1, 2, 1][Math.floor(a.anim * 8) % 4];
  else if (act === 'desk' && a.state === 'WORKING') frame = (DESKS[a.id].mode === 'typing' ? 3 : 5) + (Math.floor(a.anim * (DESKS[a.id].mode === 'typing' ? 4 : 1.5)) % 2);
  else frame = 1;
  const row = DIR_ROW[a.dir], flip = a.dir === 'LEFT';
  const x = a.x - 8, y = a.y - 31 - (seated ? 3 : 0);
  // status ring
  const ring = a.state === 'WORKING' ? '#34d399' : a.state === 'BLOCKED' ? '#f87171' : 'rgba(148,163,184,.55)';
  ctx.globalAlpha = a.state === 'BLOCKED' ? (Math.floor(t * 4) % 2 ? 0.95 : 0.3) : 0.7;
  ctx.fillStyle = ring; ctx.beginPath(); ctx.ellipse(a.x, a.y - 1, 6, 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  if (app.hoverAgent === a) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.75; ctx.strokeRect(Math.round(x) - 1.5, Math.round(y) + 2.5, 19, 30); }
  sprite(sheet, frame * 16, row * 32, 16, 32, x, y, flip);
  // name tag
  const c = CREW[a.id];
  ctx.font = '5px FSPixel'; ctx.textAlign = 'center';
  const nw = ctx.measureText(c.name).width + 4;
  ctx.fillStyle = 'rgba(2,6,15,.75)'; ctx.fillRect(Math.round(a.x - nw / 2), Math.round(y) - 3, nw, 7);
  ctx.fillStyle = c.color; ctx.fillText(c.name, Math.round(a.x), Math.round(y) + 2);
  // status icon bubble
  let icon = null;
  if (a.state === 'BLOCKED') icon = Math.floor(t * 3) % 2 ? '!' : null;
  else if (act === 'desk' && a.state === 'WORKING') icon = ['.', '..', '...'][Math.floor(t * 2) % 3];
  else if (!a.walking && act === 'couch') icon = 'z';
  else if (!a.walking && act === 'coffee') icon = '~';
  if (icon) {
    const bx = Math.round(a.x + 6), by = Math.round(y) - 7;
    ctx.fillStyle = a.state === 'BLOCKED' ? '#ef4444' : '#f8fafc'; ctx.fillRect(bx, by, 9, 7); ctx.fillRect(bx + 1, by + 7, 2, 1);
    ctx.fillStyle = a.state === 'BLOCKED' ? '#fff' : '#0f172a'; ctx.font = '5px FSPixel'; ctx.fillText(icon, bx + 4.5, by + 5);
  }
  // thought bubble with real task text when zoomed in
  const show = (a.state === 'BLOCKED') || (act === 'desk' && a.state === 'WORKING');
  if (show && (cam.z >= 4 || app.hoverAgent === a)) drawBubble(a.x, y - 9, a.state === 'BLOCKED' ? 'Needs human input' : a.task, a.state === 'BLOCKED' ? '#f87171' : c.color);
  ctx.textAlign = 'left';
}
function drawBubble(x, y, text, col) {
  ctx.font = '5px FSPixel';
  const max = 90, words = String(text || '').split(' '); const lines = []; let line = '';
  for (const w of words) { const test = line ? `${line} ${w}` : w; if (ctx.measureText(test).width > max && line) { lines.push(line); line = w; if (lines.length === 2) break; } else line = test; }
  if (lines.length < 2 && line) lines.push(line);
  if (lines.join(' ').length < String(text).length && lines.length === 2) lines[1] = lines[1].slice(0, -1) + '…';
  const w = Math.min(max, Math.max(...lines.map((l) => ctx.measureText(l).width))) + 6, h = lines.length * 6 + 4;
  const bx = Math.round(x - w / 2), by = Math.round(y - h);
  ctx.fillStyle = 'rgba(2,6,15,.88)'; ctx.fillRect(bx, by, w, h); ctx.fillStyle = col; ctx.fillRect(bx, by + h - 1, w, 1);
  ctx.fillRect(Math.round(x) - 1, by + h, 2, 2);
  ctx.fillStyle = '#e2e8f0'; ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, Math.round(x), by + 6 + i * 6));
}
function drawPet(p, t) {
  const img = pets[p.id]; if (!img) return;
  if (p.walking && (p.dir === 'LEFT' || p.dir === 'RIGHT')) sprite(img, (Math.floor(t * 8) % 3) * 32, 64, 32, 32, p.x - 16, p.y - 31, p.dir === 'LEFT');
  else sprite(img, (p.walking ? Math.floor(t * 8) % 3 : 3 + (Math.floor(t * 1.5) % 3)) * 16, p.dir === 'UP' && p.walking ? 32 : 0, 16, 32, p.x - 8, p.y - 31, false);
}
function drawRoomLabels() {
  ctx.font = '7px FSPixel'; ctx.textAlign = 'left';
  for (const [k, r] of Object.entries(ROOMS)) {
    const lx = r.x + T + 2, ly = r.y + (k === 'lounge' ? T * 1.6 : T * 1.1) + 8;
    const w = ctx.measureText(r.name).width + 8;
    ctx.fillStyle = 'rgba(2,6,15,.62)'; ctx.fillRect(lx, ly - 7, w, 10);
    ctx.fillStyle = r.accent; ctx.fillRect(lx, ly - 7, 2, 10);
    ctx.fillStyle = '#f1f5f9'; ctx.fillText(r.name, lx + 5, ly + 1);
    if (app.hoverRoom === k) { ctx.strokeStyle = r.accent; ctx.lineWidth = 1; ctx.strokeRect(r.x + T - 0.5, r.y + T - 0.5, r.w - 2 * T + 1, r.h - 2 * T + 1); }
  }
}
function drawXray(t) {
  ctx.fillStyle = 'rgba(3,10,30,.55)'; ctx.fillRect(-T, -2 * T, (COLS + 2) * T, (ROWS + 3) * T);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (tiles[idx(c, r)] === VOID) continue;
    ctx.fillStyle = blocked[idx(c, r)] ? 'rgba(248,113,113,.18)' : 'rgba(52,211,153,.10)';
    ctx.fillRect(c * T + 0.5, r * T + 0.5, T - 1, T - 1);
  }
  ctx.strokeStyle = 'rgba(56,189,248,.18)'; ctx.lineWidth = 0.5;
  for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(c * T, 0); ctx.lineTo(c * T, ROWS * T); ctx.stroke(); }
  for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * T); ctx.lineTo(COLS * T, r * T); ctx.stroke(); }
  const core = { x: 21.5 * T, y: 5 * T };
  ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.lineDashOffset = -t * 20;
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'control') continue;
    ctx.strokeStyle = r.accent; ctx.beginPath(); ctx.moveTo(core.x, core.y); ctx.lineTo(core.x, 12 * T); ctx.lineTo(r.x + r.w / 2, 12 * T); ctx.lineTo(r.x + r.w / 2, r.y + r.h / 2); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = '5px FSPixel'; ctx.fillStyle = '#7dd3fc';
  for (const r of Object.values(ROOMS)) ctx.fillText(`${r.spec} · ${(r.w / T) - 2}x${(r.h / T) - 2} tiles`, r.x + T + 2, r.y + r.h - T - 3);
  for (const a of crew) if (a.path.length) { ctx.strokeStyle = CREW[a.id].color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y - 2); for (const p of a.path) ctx.lineTo(p.c * T + 8, p.r * T + 13); ctx.stroke(); }
}

/* ---------- loop ---------- */
let last = performance.now(), fitted = false;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; const t = now / 1000;
  if (!fitted && vw) { focus(OVERVIEW, 20); cam.x = cam.tx; cam.y = cam.ty; cam.z = cam.tz; fitted = true; }
  const k = 1 - Math.pow(0.0015, dt);
  cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k; cam.z += (cam.tz - cam.z) * k;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#16141f'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!assetsReady) {
    ctx.fillStyle = '#94a3b8'; ctx.font = `${14 * dpr}px "JetBrains Mono"`; ctx.textAlign = 'center';
    ctx.fillText(assetsError ? 'Pixel Agents art not found — install it (npm i -g pixel-agents) and open via `sm dashboard`.' : 'Loading office…', cv.width / 2, cv.height / 2);
    requestAnimationFrame(frame); return;
  }
  updateCrew(dt);
  const z = cam.z * dpr;
  ctx.setTransform(z, 0, 0, z, Math.round(cv.width / 2 - cam.x * z), Math.round(cv.height / 2 - cam.y * z));
  ctx.imageSmoothingEnabled = false;
  drawFloor();
  for (const d of drawables(t)) d.fn();
  drawRoomLabels();
  if (app.xray) drawXray(t);
  requestAnimationFrame(frame);
}

/* ---------- go ---------- */
icons();
resize();
document.fonts?.load('7px FSPixel').catch(() => {});
requestAnimationFrame(frame);
boot();
