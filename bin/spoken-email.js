'use strict';
/**
 * Email addresses said out loud, read deterministically (never guessed by the model): "a l e x r i v e r a at
 * g mail dot com" → alexrivera@gmail.com. A spelled run of single letters wins over words; the last address said
 * wins (people repeat it to correct themselves). Returns { email, spelled } or null.
 */
const WORD = { at: '@', dot: '.', period: '.', point: '.', underscore: '_', dash: '-', hyphen: '-', minus: '-', plus: '+', zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const DOMAINS = [['g mail', 'gmail'], ['hot mail', 'hotmail'], ['out look', 'outlook'], ['i cloud', 'icloud'], ['ya hoo', 'yahoo'], ['proton mail', 'protonmail']];
function spokenEmail(text) {
  let t = ` ${String(text || '').toLowerCase().replace(/[,;!?"']/g, ' ').replace(/\.(?=\s|$)/g, ' ').replace(/\s+/g, ' ')} `; // a sentence's full stop is not a dot in the address
  for (const [a, b] of DOMAINS) t = t.split(` ${a} `).join(` ${b} `);
  const direct = [...t.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)].map((m) => m[0]);
  const toks = t.trim().split(' ');
  const found = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== 'at') continue;
    // local part: a spelled run of single letters/digits right before "at", else the one word before it
    let j = i - 1; const run = [];
    while (j >= 0 && (/^[a-z0-9]$/.test(toks[j]) || ['dot', 'underscore', 'dash', 'hyphen', 'period'].includes(toks[j]) || (WORD[toks[j]] && /\d/.test(WORD[toks[j]])))) { run.unshift(WORD[toks[j]] ?? toks[j]); j--; }
    const spelled = run.filter((x) => /^[a-z0-9]$/.test(x)).length >= 3;
    const local = spelled ? run.join('') : (toks[i - 1] || '').replace(/[^a-z0-9._+-]/g, '');
    // domain: words after "at" with "dot"s, until something that isn't part of it
    let k = i + 1; let dom = '';
    while (k < toks.length) {
      const w = toks[k];
      if (w === 'dot' || w === 'period') { dom += '.'; k++; continue; }
      // a word starts the domain or follows a "dot"; single spelled letters may build a word only before the first dot
      if (/^[a-z0-9-]+$/.test(w) && (dom === '' || dom.endsWith('.') || (/^[a-z0-9]$/.test(w) && !dom.includes('.')))) { dom += w; k++; continue; }
      break;
    }
    dom = dom.replace(/\.+$/, '');
    if (local && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom)) found.push({ email: `${local}@${dom}`, spelled });
  }
  const best = found.filter((f) => f.spelled).pop() || found.pop() || (direct.length ? { email: direct.pop(), spelled: false } : null);
  return best;
}
/** "alexrivera@gmail.com" → "a, l, e, x, r, i, v, e, r, a at gmail dot com" (what Ivy reads back). */
const spellEmail = (e) => { const [l, d] = String(e).split('@'); return `${l.split('').map((c) => ({ '.': 'dot', _: 'underscore', '-': 'dash' })[c] || c).join(', ')} at ${String(d || '').replace(/\./g, ' dot ')}`; };
/** A phone number said out loud ("oh five two, one two three, four five six seven", "+972 52…") → digits (7-15), or ''. */
function spokenPhone(text) {
  const t = String(text || '').toLowerCase().replace(/\bplus\b/g, '+').replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => WORD[w]).replace(/\bdouble (\d)/g, '$1$1');
  const m = t.match(/\+?\d[\d\s().,-]{5,}\d/g); if (!m) return '';
  const d = m.pop().replace(/[^\d+]/g, ''); const n = d.replace(/\D/g, '').length;
  return n >= 7 && n <= 15 ? d : '';
}
/** "+972521234567" → "plus 9 7 2, 5 2 1, 2 3 4, 5 6 7" */
const sayPhone = (p) => { const d = String(p).replace(/\D/g, ''); const g = d.match(/.{1,3}/g) || []; return `${String(p).startsWith('+') ? 'plus ' : ''}${g.map((x) => x.split('').join(' ')).join(', ')}`; };
module.exports = { spokenEmail, spellEmail, spokenPhone, sayPhone };
