/**
 * The learning box: lessons the office keeps for next time (from the owner's prompts, errors and info they share).
 * Stored in office/learnings.json; the newest lessons are written into every AI teammate's prompt (see staff.js).
 */
const fs = require('fs');
const path = require('path');

const KINDS = ['prompt', 'error', 'info'];
const MAX_LESSONS = 200;
const RULE = /\b(always|never|from now on|next time|remember|make sure|don'?t|do not|should always|must|every time|going forward)\b/i;
const BLOCK_CHARS = 1800; // what goes into a prompt: the newest lessons that fit

function createLearning(root) {
  const file = path.join(root, 'office', 'learnings.json');
  const load = () => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d.lessons) ? d.lessons : []; } catch { return []; } };
  const save = (lessons) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ lessons }, null, 2) + '\n'); };

  /** Add one lesson; the same text again is ignored (returns the existing one). */
  function add(text, { kind = 'info', source = 'owner' } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!t) throw Object.assign(new Error('Write the lesson first.'), { status: 400 });
    const lessons = load();
    const dup = lessons.find((l) => l.text.toLowerCase() === t.toLowerCase());
    if (dup) return dup;
    const l = { id: `l-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: t, kind: KINDS.includes(kind) ? kind : 'info', source: String(source).slice(0, 40), at: new Date().toISOString() };
    save([l, ...lessons].slice(0, MAX_LESSONS));
    return l;
  }
  const list = () => load();
  function remove(id) {
    const lessons = load();
    if (!lessons.some((l) => l.id === id)) throw Object.assign(new Error('No such lesson.'), { status: 404 });
    save(lessons.filter((l) => l.id !== id));
    return { ok: true };
  }
  /** Prompt text for a teammate: newest lessons first, capped. Empty when there are none. */
  function promptBlock() {
    let used = 0; const out = [];
    for (const l of load()) { const line = `- ${l.text}`; if (used + line.length > BLOCK_CHARS) break; used += line.length; out.push(line); }
    return out.length ? `What the office has learned (apply it, do not repeat old mistakes):\n${out.join('\n')}` : '';
  }
  /**
   * Lessons hiding in an owner's request: sentences that state a rule or preference ("always…", "never…", "from now on…",
   * "next time…", "remember…", "make sure…", "don't…"). Saved as kind `prompt`. Everything else in a prompt is NOT learned.
   */
  function learnFromPrompt(text, source = 'owner-prompt') {
    const saved = [];
    for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
      const t = sentence.trim();
      if (t.length < 12 || t.length > 300 || !RULE.test(t)) continue;
      try { saved.push(add(t, { kind: 'prompt', source })); } catch { /* skip */ }
      if (saved.length >= 3) break;
    }
    return saved;
  }
  return { add, list, remove, promptBlock, learnFromPrompt, KINDS };
}

module.exports = { createLearning };
