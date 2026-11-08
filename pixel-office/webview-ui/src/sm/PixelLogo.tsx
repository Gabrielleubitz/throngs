/* eslint-disable pixel-agents/no-inline-colors -- these are other companies' brand colours, not theme colours */
/** Company logos redrawn as 16x16 pixel art (like the rest of the office), one per Zoo integration. */
/** Round badge: a 16x16 disc in `B`, with `over` rows (strings of `B`/other letters/`.`=keep) laid on top. */
const badge = (over: string[]) => Array.from({ length: 16 }, (_, y) => [...Array(16).keys()].map((x) => {
  const o = over[y]?.[x];
  if (o && o !== '.') return o;
  return (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 7.8 ** 2 ? 'B' : '.';
}).join(''));
const GRID = (rows: string[]) => [...rows, ...Array(16 - rows.length).fill('................')];

const LOGOS: Record<string, { pal: Record<string, string>; rows: string[] }> = {
  whatsapp: { pal: { G: '#25D366', W: '#ffffff' }, rows: [
    '.....GGGGGG.....', '...GGGGGGGGGG...', '..GGGGGGGGGGGG..', '.GGGGWWWGGGGGGG.', '.GGGWWWWGGGGGGG.', 'GGGGWWWGGGGGGGGG', 'GGGGGWWWGGGGGGGG', 'GGGGGGWWWGGGGGGG',
    'GGGGGGGWWWGGGGGG', 'GGGGGGGGWWWWGGGG', '.GGGGGGGGWWWWGG.', '.GGGGGGGGGWWWGG.', '..GGGGGGGGGGGG..', '.GGGGGGGGGGGG...', 'GGGG.GGGGGG.....', 'GG..............'] },
  teams: { pal: { P: '#5059C9', p: '#7B83EB', W: '#ffffff' }, rows: [
    '......pppp......', '.....pppppp.PPP.', '.PPPPpppppp.PPPP', 'PPPPPPPPPPPPPPPP', 'PWWWWWWWWWWWPPPP', 'PWWWWWWWWWWWPPPP', 'PPPPPWWWWPPPPPPP', 'PPPPPWWWWPPPPPPP',
    'PPPPPWWWWPPPPPP.', 'PPPPPWWWWPPPPP..', 'PPPPPWWWWPPPP...', 'PPPPPWWWWPPPP...', 'PPPPPWWWWPPPP...', '.PPPPPPPPPPP....', '................', '................'] },
  notion: { pal: { K: '#111111', W: '#ffffff' }, rows: [
    'KKKKKKKKKKKKKKKK', 'KWWWWWWWWWWWWWWK', 'KWWWWWWWWWWWWWWK', 'KWWWKKWWWWKKWWWK', 'KWWWKKKWWWKKWWWK', 'KWWWKKKWWWKKWWWK', 'KWWWKKKKWWKKWWWK', 'KWWWKKKKKWKKWWWK',
    'KWWWKKWKKKKKWWWK', 'KWWWKKWWKKKKWWWK', 'KWWWKKWWWKKKWWWK', 'KWWWKKWWWWKKWWWK', 'KWWWKKWWWWKKWWWK', 'KWWWWWWWWWWWWWWK', 'KWWWWWWWWWWWWWWK', 'KKKKKKKKKKKKKKKK'] },
  telegram: { pal: { B: '#2AABEE', W: '#ffffff' }, rows: badge([
    '', '', '', '............WW..', '..........WWWW..', '........WWWWWW..', '......WWWWWWWW..', '....WWWWWWWWWW..', '......WWWWWW....', '.......WWWWWW...', '.......WWW.WW...', '........W...W...']) },
  slack: { pal: { C: '#36C5F0', G: '#2EB67D', Y: '#ECB22E', R: '#E01E5A' }, rows: [
    '................', '................', '.....CC...GG....', '.....CC...GG....', '.....CC...GG....', '..YYYYYYYYYYYY..', '..YYYYYYYYYYYY..', '.....CC...GG....',
    '.....CC...GG....', '..RRRRRRRRRRRR..', '..RRRRRRRRRRRR..', '.....CC...GG....', '.....CC...GG....', '.....CC...GG....', '................', '................'] },
  google: { pal: { R: '#EA4335', Y: '#FBBC05', G: '#34A853', B: '#4285F4' }, rows: [
    '.....RRRRRR.....', '...RRRRRRRRRR...', '..RRRRRRRRRRRR..', '.RRRR.......RR..', '.YYY............', 'YYYY............', 'YYYY.....BBBBBBB', 'YYYY.....BBBBBBB',
    'YYYY.........BBB', 'YYYY.........BBB', '.YYYY.......BBB.', '..GGGGG....BBB..', '..GGGGGGGGGBB...', '...GGGGGGGGGG...', '.....GGGGGG.....', '................'] },
  zoom: { pal: { B: '#2D8CFF', W: '#ffffff' }, rows: [
    '.BBBBBBBBBBBBBB.', 'BBBBBBBBBBBBBBBB', 'BBBBBBBBBBBBBBBB', 'BBBBBBBBBBBBBBBB', 'BBBBBBBBBBBBBBBB', 'BBWWWWWWWWBBBBBB', 'BBWWWWWWWWBBWBBB', 'BBWWWWWWWWBWWBBB',
    'BBWWWWWWWWWWWBBB', 'BBWWWWWWWWBWWBBB', 'BBWWWWWWWWBBWBBB', 'BBWWWWWWWWBBBBBB', 'BBBBBBBBBBBBBBBB', 'BBBBBBBBBBBBBBBB', 'BBBBBBBBBBBBBBBB', '.BBBBBBBBBBBBBB.'] },
  dropbox: { pal: { B: '#0061FF' }, rows: [
    '................', '..BBBB....BBBB..', '.BBBBBB..BBBBBB.', 'BBBBBBBBBBBBBBBB', '.BBBBBBBBBBBBBB.', '..BBBBBBBBBBBB..', '.BBBBBBBBBBBBBB.', 'BBBBBBBBBBBBBBBB',
    '.BBBBBB..BBBBBB.', '..BBBB....BBBB..', '....BBBBBBBB....', '.....BBBBBB.....', '......BBBB......', '.......BB.......', '................', '................'] },
  sms: { pal: { B: '#F22F46', W: '#ffffff' }, rows: badge([
    '', '', '', '', '....WW....WW....', '....WW....WW....', '', '', '', '....WW....WW....', '....WW....WW....']) },
  discord: { pal: { B: '#5865F2', W: '#ffffff' }, rows: [
    '................', '..BBBBBBBBBBBB..', '.BBBBBBBBBBBBBB.', '.BBBBBBBBBBBBBB.', 'BBBBBBBBBBBBBBBB', 'BBBWWBBBBBBWWBBB', 'BBWWWWBBBBWWWWBB', 'BBWWWWBBBBWWWWBB',
    'BBBWWBBBBBBWWBBB', 'BBBBBBBBBBBBBBBB', '.BBBBBBBBBBBBBB.', '.BBBBBBBBBBBBBB.', '..BBB......BBB..', '................', '................', '................'] },
};

export function PixelLogo({ id, size = 28 }: { id: string; size?: number }) {
  const logo = LOGOS[id];
  if (!logo) return <span style={{ width: size, height: size, display: 'inline-block' }} />;
  const rows = GRID(logo.rows);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" style={{ imageRendering: 'pixelated', flexShrink: 0 }} aria-label={`${id} logo`}>
      {rows.flatMap((row, y) => [...row.padEnd(16, '.')].slice(0, 16).map((ch, x) => {
        const fill = logo.pal[ch];
        return fill ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} /> : null;
      }))}
    </svg>
  );
}
