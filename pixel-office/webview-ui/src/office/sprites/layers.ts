/**
 * Layered agent looks: hair, outfit, hat and accessory drawn over the baked 16x32 sprites at runtime.
 * Every layer is optional; an empty Look leaves the sprite exactly as drawn. Option ids live in
 * lookOptions.json so the server (bin/staff.js) validates against the same list.
 */
import options from './lookOptions.json' with { type: 'json' };

export interface Look {
  hair?: string;
  hairColor?: string;
  outfit?: string;
  outfitColor?: string;
  hat?: string;
  hatColor?: string;
  accessory?: string;
}
type Sprite = string[][];
/** Same values as the office Direction: 0 down, 1 left, 2 right, 3 up (left is drawn as a mirrored right). */
type Dir = 0 | 1 | 2 | 3;

export const LOOK_OPTIONS = options;
export const LOOK_FIELDS = ['hair', 'outfit', 'hat', 'accessory'] as const;
export const COLOR_IDS = Object.keys(options.colors);
const DEFAULT_ID = { hair: 'base', outfit: 'base', hat: 'none', accessory: 'none' } as const;

/** Keep only known option ids and swatch ids; defaults are dropped so an empty look means "unchanged". */
export function sanitizeLook(raw: unknown): Look {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Look = {};
  for (const f of LOOK_FIELDS) {
    const v = r[f];
    if (typeof v === 'string' && (options[f] as string[]).includes(v) && v !== DEFAULT_ID[f]) out[f] = v;
  }
  for (const f of ['hairColor', 'outfitColor', 'hatColor'] as const) {
    const v = r[f];
    if (typeof v === 'string' && COLOR_IDS.includes(v)) out[f] = v;
  }
  return out;
}

export const lookKey = (l?: Look): string => {
  const s = sanitizeLook(l);
  return Object.keys(s).length ? JSON.stringify(s) : '';
};

// ── colour helpers ──────────────────────────────────────────────
const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const hex = (c: number[]): string => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const scale = (h: string, k: number): string => hex(rgb(h).map((v) => v * k));
const lum = (h: string): number => { const [r, g, b] = rgb(h); return (r * 0.3 + g * 0.59 + b * 0.11) / 255; };
const near = (a: string, b: string): boolean => { const x = rgb(a), y = rgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 70; };
const swatch = (id: string | undefined): string | undefined => (id ? (options.colors as Record<string, string>)[id] : undefined);
/** Reads a pixel colour as #rrggbb ('' if transparent / outside). */
const norm = (c: string | undefined): string => (c && c.startsWith('#') && c.length >= 7 ? c.slice(0, 7).toLowerCase() : '');

interface Frame { s: Sprite; T: number; L: number; w: number }
const at = (s: Sprite, x: number, y: number): string => norm(s[y]?.[x]);

function geometry(s: Sprite): Frame | null {
  const T = s.findIndex((row) => row.some((c) => c));
  if (T < 0) return null;
  let L = 99, R = -1;
  for (let y = T + 4; y <= T + 9; y++) s[y]?.forEach((c, x) => { if (c) { L = Math.min(L, x); R = Math.max(R, x); } });
  return R < 0 ? null : { s, T, L, w: R - L + 1 };
}

// ── hats: 'o' outline, 'm' main, 'a' accent; rows end on the hairline (v = 2); max 5 rows - the sprite has only 2 rows of headroom ─────
const HATS: Record<string, { rows: string[]; main: string; band?: boolean }> = {
  cap: { main: '#d94a4a', rows: ['...oooooooo...', '..ommmmmmmmo..', '.ommmmmmmmmmo.', '.oaaaaaaaaaao.'] },
  beanie: { main: '#4a7fd9', rows: ['.....oooo.....', '...oommmmoo...', '..ommmmmmmmo..', '.ommmmmmmmmmo.', '.oaaaaaaaaaao.'] },
  cowboy: { main: '#9a6a3a', rows: ['.....oooo.....', '....ommmmo....', '....oaaaao....', 'oooommmmmmoooo'.padEnd(14, '.'), '.oooooooooooo.'] },
  tophat: { main: '#2b2430', rows: ['...oooooooo...', '...ommmmmmo...', '...oaaaaaao...', '.oooooooooooo.', '..oooooooooo..'] },
  party: { main: '#e879b0', rows: ['.....oo.....', '....ommo....', '....oaao....', '...ommmmo...', '..oaaaaaao..'] },
  crown: { main: '#f0d54a', rows: ['o..o..o..o', 'ommommommo', 'ommmmmmmmo', 'oooooooooo'] },
  headband: { main: '#d94a4a', rows: [], band: true },
};

function paint(f: Frame, x: number, y: number, c: string, onlyOnBody = false): void {
  if (y < 0 || y >= f.s.length || x < 0 || x >= (f.s[0]?.length ?? 16)) return;
  if (onlyOnBody && !f.s[y][x]) return;
  f.s[y][x] = c;
}

function drawHat(f: Frame, id: string, color: string | undefined): void {
  const h = HATS[id];
  if (!h) return;
  const main = color ?? h.main;
  const acc = lum(main) > 0.55 ? scale(main, 0.75) : scale(main, 1.35);
  const edge = scale(main, 0.45);
  if (h.band) {
    for (let x = 0; x < f.w; x++) for (const v of [1, 2]) paint(f, f.L + x, f.T + v, v === 1 ? main : acc, true);
    return;
  }
  const pw = h.rows[0].length;
  const x0 = f.L + Math.floor((f.w - pw) / 2);
  const bottom = f.T + 2;
  h.rows.forEach((row, i) => {
    const y = bottom - (h.rows.length - 1 - i);
    [...row].forEach((ch, j) => { if (ch !== '.') paint(f, x0 + j, y, ch === 'o' ? edge : ch === 'a' ? acc : main); });
  });
}

// ── hair ───────────────────────────────────────────────────────
const HAIR_ROWS = 10; // the hair block: everything above the face (v 0-9)

/** Recolours the hair block, keeping the sprite's own shading (outline, highlights) relative to its base hair colour. */
function recolorHair(f: Frame, c: string, base: string): void {
  const ref = Math.max(0.2, lum(base));
  for (let v = 0; v < HAIR_ROWS; v++) for (let x = 0; x < f.w; x++) {
    const px = at(f.s, f.L + x, f.T + v);
    if (px) paint(f, f.L + x, f.T + v, scale(c, Math.max(0.45, Math.min(1.3, lum(px) / ref))));
  }
}

function drawHair(f: Frame, id: string, c: string, base: string, skin: string, dir: Dir): void {
  const back = dir === 3, side = dir === 2;
  const m = Math.floor(f.w / 2);
  const tone = (u: number, v: number) => (v === 0 ? scale(c, 0.55) : (u + v) % 4 === 0 ? scale(c, 1.2) : c);
  const hairAt = (u: number, v: number) => paint(f, f.L + u, f.T + v, tone(u, v));
  const skinBlock = () => { for (let v = 0; v < HAIR_ROWS; v++) for (let u = 0; u < f.w; u++) if (f.s[f.T + v]?.[f.L + u]) paint(f, f.L + u, f.T + v, v === 0 ? scale(skin, 0.6) : skin); };
  if (id !== 'bald' && id !== 'mohawk') recolorHair(f, c, base);
  switch (id) {
    case 'short': // trimmed sides and neckline show a bit of skin
      if (!back) for (let v = 7; v < HAIR_ROWS; v++) for (const u of side ? [f.w - 1] : [0, f.w - 1]) paint(f, f.L + u, f.T + v, skin, true);
      break;
    case 'long':
      for (let v = HAIR_ROWS; v < (back ? 19 : 17); v++) for (const u of back ? [...Array(f.w - 2).keys()].map((n) => n + 1) : side ? [0, 1] : [0, 1, f.w - 2, f.w - 1]) hairAt(u, v);
      break;
    case 'ponytail': {
      const cols = back ? [m - 1, m] : side ? [-2, -1] : [f.w, f.w + 1];
      for (let v = back ? HAIR_ROWS : 4; v < (back ? 18 : 14); v++) for (const u of cols) hairAt(u, v);
      break;
    }
    case 'bun':
      for (let v = -2; v < 0; v++) for (let u = m - 3; u < m + 3; u++) if (!(v === -2 && (u === m - 3 || u === m + 2))) hairAt(u, v);
      break;
    case 'curly':
      for (let u = 0; u < f.w; u += 2) hairAt(u, -1);
      for (let v = 1; v < 9; v += 2) { hairAt(-1, v); hairAt(f.w, v); }
      break;
    case 'mohawk':
      skinBlock();
      for (let v = -2; v < (back ? HAIR_ROWS : 5); v++) for (let u = m - 1; u <= m; u++) hairAt(u, v);
      break;
    case 'bald':
      skinBlock();
      break;
    default: break; // 'base': only the colour (if picked) changes
  }
}

// ── outfit ─────────────────────────────────────────────────────
const OUTFIT_DEFAULT: Record<string, string> = { hoodie: '#8a8f98', suit: '#2c3e7a', dress: '#e879b0', labcoat: '#f2f2f2', overalls: '#4a7fd9', tee: '#4fae5b' };

function drawOutfit(f: Frame, id: string, color: string | undefined, skin: string): void {
  const main = color ?? OUTFIT_DEFAULT[id];
  if (!main) return;
  const [v0, v1] = id === 'tee' ? [12, 19] : id === 'dress' || id === 'labcoat' ? [12, 24] : id === 'overalls' ? [15, 24] : [12, 21];
  const cx = f.L + Math.floor(f.w / 2);
  for (let v = v0; v <= v1; v++) for (let x = 0; x < (f.s[0]?.length ?? 16); x++) {
    const px = at(f.s, x, f.T + v);
    if (!px || near(px, skin)) continue;
    if (id === 'overalls' && v < 15) continue;
    if (id === 'overalls' && x < f.L + 3 && v >= 15 && v < 18) continue; // sleeves keep shirt
    paint(f, x, f.T + v, lum(px) < 0.25 ? scale(main, 0.55) : scale(main, 0.8 + lum(px) * 0.4));
  }
  const accent = lum(main) > 0.55 ? scale(main, 0.7) : scale(main, 1.4);
  const dot = (x: number, v: number, c: string) => { if (f.s[f.T + v]?.[x] && !near(at(f.s, x, f.T + v), skin)) paint(f, x, f.T + v, c); };
  if (id === 'hoodie') { for (let x = f.L + 2; x < f.L + f.w - 2; x++) dot(x, 12, accent); dot(cx - 1, 14, '#f2f2f2'); dot(cx, 14, '#f2f2f2'); dot(cx - 1, 15, '#f2f2f2'); dot(cx, 15, '#f2f2f2'); }
  if (id === 'suit') { for (let v = 12; v <= 15; v++) { dot(cx - 1, v, v === 14 ? '#d94a4a' : '#f2f2f2'); dot(cx, v, v === 14 ? '#d94a4a' : '#f2f2f2'); } dot(cx, 18, accent); }
  if (id === 'labcoat') for (let v = 14; v <= 24; v++) dot(cx, v, scale(main, 0.65));
  if (id === 'dress') for (let x = f.L + 1; x < f.L + f.w - 1; x++) dot(x, 19, accent);
  if (id === 'overalls') { dot(f.L + 3, 12, main); dot(f.L + 3, 13, main); dot(f.L + 3, 14, main); dot(f.L + f.w - 4, 12, main); dot(f.L + f.w - 4, 13, main); dot(f.L + f.w - 4, 14, main); }
}

// ── accessories (face views only) ──────────────────────────────
function drawAccessory(f: Frame, id: string, dir: Dir): void {
  const dark = '#2b2430';
  if (dir === 3) { if (id === 'headphones') for (let v = 1; v < 9; v++) for (const u of [0, f.w - 1]) paint(f, f.L + u, f.T + v, dark); return; }
  if (id === 'glasses' || id === 'sunglasses') {
    const [u0, u1] = dir === 0 ? [3, 10] : [f.w - 7, f.w - 1];
    for (let u = u0; u <= u1; u++) {
      if (id === 'sunglasses') { paint(f, f.L + u, f.T + 11, '#15121a'); paint(f, f.L + u, f.T + 12, '#15121a'); }
      else { paint(f, f.L + u, f.T + 10, dark); paint(f, f.L + u, f.T + 13, dark); if (u === u0 || u === u1) { paint(f, f.L + u, f.T + 11, dark); paint(f, f.L + u, f.T + 12, dark); } }
    }
  }
  if (id === 'headphones') {
    for (let v = 1; v < 9; v++) paint(f, f.L + (dir === 0 ? 0 : 1), f.T + v, dark);
    for (let u = 1; u < f.w - 1; u++) paint(f, f.L + u, f.T, dark);
    for (const u of dir === 0 ? [-1, f.w] : [2, 3]) for (let v = 7; v < 12; v++) paint(f, f.L + u, f.T + v, '#d94a4a');
  }
}

function flip(s: Sprite): Sprite { return s.map((r) => [...r].reverse()); }

/** Draw one frame. `dir` uses the office Direction values: 0 down, 1 up, 2 left, 3 right. */
export function applyLookToFrame(src: Sprite, look: Look, dir: Dir, skin: string, hair: string): Sprite {
  let s = src.map((r) => [...r]);
  if (dir === 1) s = flip(s);
  const f = geometry(s);
  if (f) {
    const d: Dir = dir === 1 ? 2 : dir;
    if (look.outfit || look.outfitColor) drawOutfit(f, look.outfit ?? 'base', swatch(look.outfitColor), skin);
    if (look.hair || look.hairColor) drawHair(f, look.hair ?? 'base', swatch(look.hairColor) ?? hair, hair, skin, d);
    if (look.accessory) drawAccessory(f, look.accessory, d);
    if (look.hat) drawHat(f, look.hat === 'headband' ? 'headband' : look.hat, swatch(look.hatColor));
  }
  return dir === 1 ? flip(s) : s;
}

/** Skin and default hair colour, sampled from the character's own front frame. */
export function sampleColors(front: Sprite): { skin: string; hair: string } {
  const f = geometry(front);
  if (!f) return { skin: '#c8a080', hair: '#5a3a20' };
  return { skin: at(front, f.L + Math.floor(f.w / 2), f.T + 11) || '#c8a080', hair: at(front, f.L + 3, f.T + 1) || '#5a3a20' };
}

export function applyLookToSet<T extends { walk: Record<number, Sprite[]>; typing: Record<number, Sprite[]>; reading: Record<number, Sprite[]> }>(sprites: T, rawLook: Look): T {
  const look = sanitizeLook(rawLook);
  if (!Object.keys(look).length) return sprites;
  const { skin, hair } = sampleColors(sprites.walk[0][0]);
  const run = (m: Record<number, Sprite[]>) => Object.fromEntries(Object.entries(m).map(([d, fr]) => [d, fr.map((s) => applyLookToFrame(s, look, Number(d) as Dir, skin, hair))])) as Record<number, Sprite[]>;
  return { ...sprites, walk: run(sprites.walk), typing: run(sprites.typing), reading: run(sprites.reading) };
}
