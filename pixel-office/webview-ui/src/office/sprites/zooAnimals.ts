/**
 * Success Manager zoo animals: tiny hand-drawn 16×16 side-view sprites, built in code so no art
 * files are needed. They are appended to the loaded pets (see setPetTemplates) after the bundled
 * ones and live only inside the Zoo (see isZooPet in petEntity).
 */
import type { SpriteData } from '../types.js';

const SIZE = 16;
type Frames = [SpriteData, SpriteData, SpriteData];

interface Animal {
  name: string;
  /** Rows facing right, bottom-aligned into 16×16; '.' is transparent. */
  rows: string[];
  pal: Record<string, string>;
}

const ANIMALS: Animal[] = [
  {
    name: 'WhatsApp the Lion',
    pal: { Y: '#D9A441', M: '#9A5B1E', K: '#2B1B0C', N: '#6B3E1A' },
    rows: [
      '.........MMMM...',
      '........MMMMMM..',
      '.YYYYYYYMMKYYY..',
      'YYYYYYYYMMYYYYN.',
      'YYYYYYYYYMYYYY..',
      '.YYYYYYYYY......',
      '.YYYYYYYYY......',
      '.Y.Y....Y.Y.....',
      '.Y.Y....Y.Y.....',
      '.K.K....K.K.....',
    ],
  },
  {
    name: 'Teams the Elephant',
    pal: { G: '#8E9AA8', D: '#6B7684', K: '#1E232B', W: '#F2F2F2' },
    rows: [
      '........GGGGG...',
      '.......GGGGGGG..',
      '..GGGGGGGGKGGG..',
      '.GGGGGGGGGGGGGG.',
      'GGGGGGGGGDGGGGGG',
      'GGGGGGGGGDGGWGGG',
      'GGGGGGGGGGGGGGGG',
      'GGGGGGGGGGGG.GG.',
      '.GG.GG...GG..GG.',
      '.DD.DD...DD..DD.',
    ],
  },
  {
    name: 'Notion the Giraffe',
    pal: { Y: '#E7B64A', B: '#8A5522', K: '#2B1B0C', H: '#6B4020' },
    rows: [
      '..........YYB...',
      '.........YYYKYY.',
      '..........YYYY..',
      '..........YBY...',
      '..........YYB...',
      '..........BYY...',
      '.YYYYYYYYYYY....',
      'YBYYBYYBYYBY....',
      'YYYYYYYYYYYY....',
      '.Y.Y......Y.Y...',
      '.Y.Y......Y.Y...',
      '.H.H......H.H...',
    ],
  },
  {
    name: 'Telegram the Penguin',
    pal: { K: '#1F2937', W: '#F5F5F5', O: '#F59E0B' },
    rows: [
      '......KKKK......',
      '.....KKKKKK.....',
      '.....KWKKKKOO...',
      '.....KKKKKK.....',
      '....KKWWWWKK....',
      '....KKWWWWKK....',
      '...KKKWWWWKKK...',
      '...KKKWWWWKKK...',
      '....KKWWWWKK....',
      '.....KKKKKK.....',
      '.....OO..OO.....',
    ],
  },
  {
    name: 'Slack the Monkey',
    pal: { B: '#7A4A25', T: '#D9B38C', K: '#1B120A' },
    rows: [
      '........BBBB....',
      '.......BTTTTB...',
      '.......BTKTKB...',
      '.......BTTTTB...',
      '........BBBB....',
      '..BBBBBBBBB.....',
      '.BBBBBBBBBB.....',
      'BBBBBBBBBBB.....',
      'B.BBBBBBBB......',
      'B.B.B...B.B.....',
      'BB..B...B.B.....',
    ],
  },
  {
    name: 'Google the Zebra',
    pal: { W: '#F5F5F5', K: '#1F2937' },
    rows: [
      '..........KWWK..',
      '.........WWWKWW.',
      '.WWWWWWWWKWWWWWK',
      'WKWKWKWKWWWWWWWW',
      'WKWKWKWKWWWK....',
      'WWWWWWWWWW......',
      '.W.W....W.W.....',
      '.W.W....W.W.....',
      '.K.K....K.K.....',
    ],
  },
  {
    name: 'Zoom the Owl',
    pal: { B: '#8B6A45', L: '#D8BE94', W: '#F5F5F5', K: '#1B120A', O: '#F59E0B' },
    rows: [
      '.....B....B.....',
      '....BBBBBBBB....',
      '....BWKBBWKB....',
      '....BBBOOBBB....',
      '...BBLLLLLLBB...',
      '...BLBLLLLBLB...',
      '...BLLBLLBLLB...',
      '...BBLLLLLLBB...',
      '....BBBBBBBB....',
      '.....O....O.....',
    ],
  },
  {
    name: 'Dropbox the Bear',
    pal: { B: '#7B4A2A', T: '#C99A6B', K: '#1B120A' },
    rows: [
      '........BB.BB...',
      '........BBBBBB..',
      '.BBBBBBBBBKBBB..',
      'BBBBBBBBBBBBBBK.',
      'BBBBBBBBBBTTTT..',
      'BBBBBBBBBBBBB...',
      'BBBBBBBBBBB.....',
      '.BB.BB..BB.BB...',
      '.BB.BB..BB.BB...',
      '.KK.KK..KK.KK...',
    ],
  },
  {
    name: 'SMS the Fox',
    pal: { O: '#E2762B', W: '#F5F5F5', K: '#1B120A', D: '#8A3E10' },
    rows: [
      '...........O.O..',
      '..........OOOOO.',
      '.........OOKOOOK',
      'OO.OOOOOOOOOOWWK',
      'OOOOOOOOOOOOOW..',
      'WWOOOOOOOOOOO...',
      '.WW.OOOOOOO.....',
      '....O.O..O.O....',
      '....O.O..O.O....',
      '....D.D..D.D....',
    ],
  },
  {
    name: 'Discord the Duck',
    pal: { Y: '#F4D03F', O: '#F59E0B', K: '#1B120A', W: '#F5F5F5' },
    rows: [
      '..........YYY...',
      '.........YYYKY..',
      '.........YYYYOOO',
      '..........YYY...',
      '.....YYYYYYY....',
      '..YYYYYYYYYYY...',
      '.YYYWWYYYYYYY...',
      '.YYYYWWYYYYY....',
      '..YYYYYYYYYY....',
      '.....O....O.....',
    ],
  },
];

function toSprite(a: Animal, dy: number, flip: boolean): SpriteData {
  const rows = a.rows.map((r) => r.padEnd(SIZE, '.').slice(0, SIZE));
  const out: SpriteData = [];
  for (let y = 0; y < SIZE; y++) {
    const src = y - (SIZE - rows.length) - dy;
    const line = Array.from(src >= 0 && src < rows.length ? rows[src] : '.'.repeat(SIZE), (ch) => a.pal[ch] ?? '');
    out.push(flip ? line.reverse() : line);
  }
  return out;
}

function frames(a: Animal, flip: boolean): Frames {
  return [toSprite(a, 0, flip), toSprite(a, 1, flip), toSprite(a, 0, flip)];
}

export const ZOO_PET_NAMES = ANIMALS.map((a) => a.name);

/** Raw template entries in the shape setPetTemplates expects (right = side view, up = mirrored). */
export function zooPetTemplates() {
  return ANIMALS.map((a) => {
    const right = frames(a, false);
    const left = frames(a, true);
    return { walkDown: right, idleDown: right, walkUp: left, idleUp: left, walkRight: right };
  });
}

/** Right-facing frames (still, step) of zoo animal `k`, for the 3D office. */
export function zooAnimalFrames(k: number): [SpriteData, SpriteData] | null {
  const a = ANIMALS[k];
  return a ? [toSprite(a, 0, false), toSprite(a, 1, false)] : null;
}
