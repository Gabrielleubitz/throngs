// Generates the extra pixel-art furniture (PNG + manifest.json) under public/assets/furniture/.
// Run from webview-ui/: node scripts/gen-furniture.cjs   (safe to re-run; only touches the ids below)
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const OUT = path.join(__dirname, '..', 'public', 'assets', 'furniture');
const K = '#2b2233'; // outline

function make(w, h) {
  const px = Array.from({ length: h }, () => Array(w).fill(null));
  const r = (x, y, ww, hh, c) => { for (let j = y; j < y + hh; j++) for (let i = x; i < x + ww; i++) if (i >= 0 && j >= 0 && i < w && j < h) px[j][i] = c; };
  // box with 1px outline and fill
  const box = (x, y, ww, hh, fill, edge = K) => { r(x, y, ww, hh, edge); r(x + 1, y + 1, ww - 2, hh - 2, fill); };
  return { w, h, px, r, box };
}

const items = [];
const add = (id, name, category, w, h, fw, fh, draw, o = {}) => items.push({ id, name, category, w, h, fw, fh, draw, ...o });

add('ARMCHAIR', 'Armchair', 'chairs', 16, 16, 1, 1, (c) => {
  c.box(2, 1, 12, 8, '#b5546b'); c.box(0, 6, 4, 9, '#8c3a50'); c.box(12, 6, 4, 9, '#8c3a50'); c.box(3, 8, 10, 6, '#d06a82'); c.r(5, 3, 6, 1, '#e58aa0'); c.r(3, 14, 2, 2, K); c.r(11, 14, 2, 2, K);
}, { backgroundTiles: 0 });
add('BEANBAG', 'Bean bag', 'chairs', 16, 16, 1, 1, (c) => {
  c.box(3, 3, 10, 5, '#4f8fd6'); c.box(1, 6, 14, 9, '#4f8fd6'); c.r(4, 5, 4, 2, '#7db3ee'); c.r(3, 9, 3, 2, '#7db3ee'); c.r(2, 13, 12, 1, '#3a6fae');
});
add('STOOL', 'Stool', 'chairs', 16, 16, 1, 1, (c) => {
  c.box(3, 4, 10, 4, '#d9a441'); c.r(4, 8, 2, 7, K); c.r(10, 8, 2, 7, K); c.r(5, 8, 1, 6, '#9a6b2a'); c.r(10, 8, 1, 6, '#9a6b2a');
});
add('FILING_CABINET', 'Filing cabinet', 'storage', 16, 32, 1, 2, (c) => {
  c.box(1, 2, 14, 29, '#8a97a8'); for (const y of [4, 12, 20]) { c.box(3, y, 10, 7, '#a9b6c6'); c.r(6, y + 3, 4, 1, K); }
}, { backgroundTiles: 1 });
add('LOCKERS', 'Lockers', 'storage', 32, 32, 2, 2, (c) => {
  c.box(0, 1, 32, 31, '#4a7a9c'); for (const x of [2, 17]) { c.box(x, 3, 13, 27, '#5f93b8'); c.r(x + 3, 6, 7, 1, K); c.r(x + 3, 8, 7, 1, K); c.r(x + 10, 16, 2, 3, '#e8e0c8'); }
}, { backgroundTiles: 1 });
add('FRIDGE', 'Fridge', 'storage', 16, 32, 1, 2, (c) => {
  c.box(1, 1, 14, 30, '#dfe6ee'); c.r(2, 11, 12, 1, K); c.r(12, 4, 1, 5, '#8a97a8'); c.r(12, 14, 1, 8, '#8a97a8'); c.r(3, 3, 6, 1, '#fff');
}, { backgroundTiles: 1 });
add('BOOK_CART', 'Book cart', 'storage', 16, 16, 1, 1, (c) => {
  c.box(1, 2, 14, 9, '#a8743a'); c.r(2, 3, 3, 4, '#d65a5a'); c.r(5, 4, 3, 3, '#5a8fd6'); c.r(8, 3, 3, 4, '#6cc070'); c.r(11, 4, 3, 3, '#e0c050'); c.r(2, 11, 2, 4, K); c.r(12, 11, 2, 4, K);
});
add('SERVER_RACK', 'Server rack', 'electronics', 16, 32, 1, 2, (c) => {
  c.box(1, 1, 14, 30, '#2f3640'); for (let y = 4; y < 28; y += 6) { c.box(3, y, 10, 4, '#454f5c'); c.r(10, y + 1, 1, 1, '#5be07a'); c.r(11, y + 1, 1, 1, '#e0a040'); }
}, { backgroundTiles: 1 });
add('LAPTOP', 'Laptop', 'electronics', 16, 16, 1, 1, (c) => {
  c.box(3, 3, 10, 7, '#3a4150'); c.r(4, 4, 8, 5, '#6fb7e8'); c.r(5, 5, 4, 1, '#bfe4fa'); c.box(1, 10, 14, 3, '#aab4c2');
}, { backgroundTiles: 0, surface: true });
add('PRINTER', 'Printer', 'electronics', 16, 16, 1, 1, (c) => {
  c.box(1, 6, 14, 8, '#c9d1da'); c.box(3, 2, 10, 5, '#fff'); c.r(4, 10, 8, 2, K); c.r(12, 8, 1, 1, '#5be07a');
}, { backgroundTiles: 0, surface: true });
add('TV_STAND', 'TV on stand', 'electronics', 32, 32, 2, 2, (c) => {
  c.box(1, 2, 30, 18, '#1f2630'); c.r(3, 4, 26, 14, '#3b7fbf'); c.r(5, 6, 10, 3, '#8cc4f0'); c.box(8, 22, 16, 8, '#8c6a3c'); c.r(12, 20, 8, 2, K);
}, { backgroundTiles: 1 });
add('LAMP', 'Floor lamp', 'decor', 16, 32, 1, 2, (c) => {
  c.box(3, 2, 10, 9, '#f2d675'); c.r(5, 4, 6, 3, '#fff2b0'); c.r(7, 11, 2, 17, K); c.box(4, 28, 8, 3, '#5a4a6a');
}, { backgroundTiles: 1 });
add('TREE_PLANT', 'Big tree plant', 'decor', 32, 32, 2, 2, (c) => {
  c.box(10, 1, 12, 8, '#3f9a4f'); c.box(4, 7, 12, 8, '#4cb35e'); c.box(16, 7, 12, 8, '#4cb35e'); c.box(9, 13, 14, 7, '#3f9a4f');
  c.r(15, 19, 2, 6, '#7a5230'); c.box(10, 25, 12, 6, '#b5683c');
}, { backgroundTiles: 1 });
add('FLOWERS', 'Flower vase', 'decor', 16, 16, 1, 1, (c) => {
  c.r(7, 5, 1, 5, '#3f9a4f'); c.r(4, 5, 1, 5, '#3f9a4f'); c.r(11, 6, 1, 4, '#3f9a4f');
  c.box(6, 1, 3, 3, '#e85a8a'); c.box(3, 2, 3, 3, '#f2d675'); c.box(10, 3, 3, 3, '#b07be0'); c.box(4, 9, 8, 6, '#6fb7e8'); c.r(5, 10, 2, 3, '#bfe4fa');
}, { backgroundTiles: 0, surface: true });
add('ROUND_TABLE', 'Round table', 'desks', 32, 32, 2, 2, (c) => {
  c.box(2, 4, 28, 22, '#a8743a'); c.box(4, 6, 24, 18, '#c58f4e'); c.r(12, 8, 8, 2, '#dcae72'); c.r(4, 26, 3, 5, K); c.r(25, 26, 3, 5, K);
}, { backgroundTiles: 1 });
add('CONFERENCE_TABLE', 'Conference table', 'desks', 64, 32, 4, 2, (c) => {
  c.box(1, 3, 62, 24, '#8c5a32'); c.box(3, 5, 58, 20, '#a8743a'); c.r(8, 8, 48, 2, '#c58f4e'); c.r(4, 27, 3, 4, K); c.r(57, 27, 3, 4, K);
}, { backgroundTiles: 1 });
add('STANDING_DESK', 'Standing desk', 'desks', 32, 32, 2, 2, (c) => {
  c.box(1, 3, 30, 8, '#c9d1da'); c.r(14, 11, 4, 17, K); c.box(6, 28, 20, 3, '#5a6676'); c.r(2, 4, 28, 1, '#fff');
}, { backgroundTiles: 1 });
add('VENDING_MACHINE', 'Vending machine', 'misc', 16, 32, 1, 2, (c) => {
  c.box(1, 1, 14, 30, '#d65a5a'); c.box(3, 3, 10, 14, '#2f3640'); c.r(4, 5, 3, 3, '#6fb7e8'); c.r(8, 5, 3, 3, '#e0c050'); c.r(4, 10, 3, 3, '#6cc070'); c.r(8, 10, 3, 3, '#e8e0c8'); c.box(4, 22, 8, 5, K);
}, { backgroundTiles: 1 });
add('WATER_COOLER', 'Water cooler', 'misc', 16, 32, 1, 2, (c) => {
  c.box(4, 1, 8, 10, '#8cc8f0'); c.box(3, 11, 10, 18, '#e4eaf0'); c.r(5, 15, 2, 2, '#4f8fd6'); c.r(9, 15, 2, 2, '#d65a5a'); c.r(5, 21, 6, 3, K);
}, { backgroundTiles: 1 });
add('TRASH_CAN', 'Trash can', 'misc', 16, 16, 1, 1, (c) => {
  c.box(3, 3, 10, 12, '#7d8794'); c.r(2, 2, 12, 2, K); c.r(5, 5, 1, 8, '#aab4c2'); c.r(8, 5, 1, 8, '#aab4c2'); c.r(11, 5, 1, 8, '#aab4c2');
});
add('WALL_TV', 'Wall TV', 'wall', 32, 16, 2, 1, (c) => {
  c.box(1, 1, 30, 14, '#1f2630'); c.r(3, 3, 26, 10, '#3b7fbf'); c.r(5, 5, 8, 2, '#8cc4f0');
}, { backgroundTiles: 0, wall: true });
add('WALL_SHELF', 'Wall shelf', 'wall', 32, 16, 2, 1, (c) => {
  c.r(1, 10, 30, 3, K); c.r(1, 10, 30, 2, '#a8743a'); c.box(4, 4, 4, 6, '#d65a5a'); c.box(9, 3, 4, 7, '#5a8fd6'); c.box(18, 5, 6, 5, '#6cc070'); c.box(25, 2, 4, 8, '#e0c050');
}, { backgroundTiles: 0, wall: true });
add('POSTER', 'Poster', 'wall', 16, 32, 1, 2, (c) => {
  c.box(2, 2, 12, 28, '#f4efe0'); c.r(4, 5, 8, 8, '#e85a8a'); c.r(5, 14, 6, 6, '#6fb7e8'); c.r(4, 23, 8, 1, K); c.r(4, 26, 5, 1, K);
}, { backgroundTiles: 1, wall: true });
add('FIRE_EXTINGUISHER', 'Fire extinguisher', 'wall', 16, 16, 1, 1, (c) => {
  c.box(5, 4, 6, 11, '#d63a3a'); c.r(6, 1, 4, 3, K); c.r(10, 2, 3, 1, K); c.r(6, 8, 4, 3, '#f4efe0');
}, { backgroundTiles: 0, wall: true });

const hex = (s) => { if (s.length === 4) s = '#' + [1, 2, 3].map((i) => s[i] + s[i]).join(''); return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)); };
function writePng(file, w, h, px) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = px[y][x]; const o = (y * w + x) * 4;
    if (v) { const [R, G, B] = hex(v); png.data[o] = R; png.data[o + 1] = G; png.data[o + 2] = B; png.data[o + 3] = 255; }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}
// Seen from behind: the front picture flipped left-right and a touch darker (no face, buttons or screen).
// Seen from the side: the same picture squeezed to the depth of the footprint and stood upright (never lying down), also darker.
const dim = (v, k) => { if (!v) return v; const [R, G, B] = hex(v); return '#' + [R, G, B].map((n) => Math.round(n * k).toString(16).padStart(2, '0')).join(''); };
const backView = (px) => px.map((row) => row.slice().reverse().map((v) => dim(v, 0.82)));
// Tall upright things (fridge, rack) keep their size and footprint: the profile is just narrower, centred.
const tallSide = (px, w, h) => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => {
  const nw = Math.round(w * 0.7), x0 = Math.floor((w - nw) / 2);
  return x < x0 || x >= x0 + nw ? null : dim(px[y][Math.floor(((x - x0) * w) / nw)], 0.9);
}));
// new image is h wide and w tall (the footprint turned 90 degrees), the object standing on the bottom edge
const sideView = (px, w, h) => Array.from({ length: w }, (_, y) => Array.from({ length: h }, (_, x) => {
  const sy = y - (w - h);
  return sy < 0 ? null : dim(px[sy][Math.floor((x * w) / h)], 0.9);
}));

for (const it of items) {
  const c = make(it.w, it.h);
  it.draw(c);
  const dir = path.join(OUT, it.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f !== 'manifest.json') fs.unlinkSync(path.join(dir, f));
  writePng(path.join(dir, `${it.id}.png`), it.w, it.h, c.px);
  const common = { category: it.category, canPlaceOnWalls: !!it.wall, canPlaceOnSurfaces: !!it.surface, backgroundTiles: it.backgroundTiles ?? 0 };
  if (it.wall) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      id: it.id, name: it.name, ...common, type: 'asset', width: it.w, height: it.h, footprintW: it.fw, footprintH: it.fh,
    }, null, 2) + '\n');
    continue;
  }
  // Rotatable: front (keeps the plain id so placed items stay valid), back, and a side profile (mirrored for the other side).
  writePng(path.join(dir, `${it.id}_BACK.png`), it.w, it.h, backView(c.px));
  const tall = it.h > it.w;
  writePng(path.join(dir, `${it.id}_SIDE.png`), tall ? it.w : it.h, tall ? it.h : it.w, tall ? tallSide(c.px, it.w, it.h) : sideView(c.px, it.w, it.h));
  const m = (id, file, w, h, fw, fh, orientation, extra = {}) => ({ type: 'asset', id, file, width: w, height: h, footprintW: fw, footprintH: fh, orientation, ...extra });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: it.id, name: it.name, category: it.category, type: 'group', groupType: 'rotation', rotationScheme: '3-way-mirror',
    canPlaceOnWalls: false, canPlaceOnSurfaces: !!it.surface, backgroundTiles: common.backgroundTiles,
    members: [
      m(it.id, `${it.id}.png`, it.w, it.h, it.fw, it.fh, 'front'),
      m(`${it.id}_BACK`, `${it.id}_BACK.png`, it.w, it.h, it.fw, it.fh, 'back'),
      m(`${it.id}_SIDE`, `${it.id}_SIDE.png`, tall ? it.w : it.h, tall ? it.h : it.w, tall ? it.fw : it.fh, tall ? it.fh : it.fw, 'side', { mirrorSide: true }),
    ],
  }, null, 2) + '\n');
}
console.log(`wrote ${items.length} furniture items`);
