/**
 * Adds what's new in the generated layout to the owner's live layout without undoing their edits
 * (grown floor, moved or added furniture). New = floor where the live layout is still empty (VOID), new
 * room areas (the grid grows when the generated one is bigger), doors the generated layout cuts into the owner's walls next to that new floor, and generated furniture with a named uid (not the positional `sm-f-N`) the live layout lacks.
 *   node office-layout/merge.js <generated.json> <live.json>   → prints the merged layout
 */
const VOID = 255, WALL = 0;
const NAMED = /^sm-(?!f-\d)/;

/** Grow a layout's grid (new cells are VOID) so new rooms past its old edge fit; furniture keeps its tiles. */
function grow(out, cols, rows) {
  if (cols <= out.cols && rows <= out.rows) return;
  const C = Math.max(cols, out.cols), R = Math.max(rows, out.rows);
  const remap = (arr, fill) => {
    const next = new Array(C * R).fill(fill);
    for (let r = 0; r < out.rows; r++) for (let c = 0; c < out.cols; c++) next[r * C + c] = arr[r * out.cols + c];
    return next;
  };
  out.tiles = remap(out.tiles, VOID);
  out.tileColors = remap(out.tileColors, null);
  out.areaTiles = remap(out.areaTiles, null);
  out.cols = C; out.rows = R;
}

function mergeLayout(live, gen) {
  const out = JSON.parse(JSON.stringify(live));
  out.tileColors = out.tileColors || new Array(out.tiles.length).fill(null);
  out.areaTiles = out.areaTiles || new Array(out.tiles.length).fill(null);
  grow(out, gen.cols, gen.rows);
  const rows = Math.min(gen.rows, out.rows), cols = Math.min(gen.cols, out.cols);
  const copy = (r, c) => {
    const gi = r * gen.cols + c, li = r * out.cols + c;
    out.tiles[li] = gen.tiles[gi];
    out.tileColors[li] = gen.tileColors?.[gi] ?? null;
    out.areaTiles[li] = gen.areaTiles?.[gi] ?? null;
  };
  const added = new Set();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (out.tiles[r * out.cols + c] !== VOID || gen.tiles[r * gen.cols + c] === VOID) continue;
    copy(r, c);
    if (gen.tiles[r * gen.cols + c] !== WALL) added.add(`${c},${r}`);
  }
  // a door: the owner's wall is floor in the generated layout and touches floor that was just added
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const g = gen.tiles[r * gen.cols + c];
    if (out.tiles[r * out.cols + c] !== WALL || g === WALL || g === VOID) continue;
    if ([[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dc, dr]) => added.has(`${c + dc},${r + dr}`))) copy(r, c);
  }
  out.areas = out.areas || [];
  for (const a of gen.areas || []) if (!out.areas.some((x) => x.label === a.label)) out.areas.push(a);
  const have = new Set(out.furniture.map((f) => f.uid));
  const taken = new Set(out.furniture.map((f) => `${f.col},${f.row}`));
  for (const f of gen.furniture) {
    if (!NAMED.test(f.uid) || have.has(f.uid) || taken.has(`${f.col},${f.row}`) || f.col >= out.cols || f.row >= out.rows) continue;
    out.furniture.push({ ...f });
  }
  // zoo animals added later (sm-zoo-N): the owner's layout gets any it lacks
  out.pets = out.pets || [];
  const havePet = new Set(out.pets.map((x) => x.id));
  for (const p of gen.pets || []) if (/^sm-zoo-\d+$/.test(p.id) && !havePet.has(p.id)) out.pets.push({ ...p });
  out.layoutRevision = (out.layoutRevision || 1) + 1;
  return out;
}

if (require.main === module) {
  const fs = require('fs');
  const [genF, liveF] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(mergeLayout(JSON.parse(fs.readFileSync(liveF, 'utf8')), JSON.parse(fs.readFileSync(genF, 'utf8'))), null, 2) + '\n');
}
module.exports = { mergeLayout };
