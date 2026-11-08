'use strict';
/**
 * IVY's live voice brain: ONE warm Claude session per phone call (`claude -p --input-format stream-json
 * --output-format stream-json --include-partial-messages`), so there is no program start-up per turn and the reply
 * streams. Each finished sentence is handed to `onSentence` the moment it exists (the phone speaks it while the rest is
 * still being written). The model writes its spoken reply first and, only when it acts, a last line
 * `ACTION: {json}` (never spoken). Measured 2026-11-01: first words in ~0.6-1.4s on Haiku vs ~4s+ per cold turn.
 * Turns run one at a time (the CLI queues input); a stale turn is drained silently.
 */
const { spawn } = require('child_process');
const os = require('os');

const SENTENCE = /^[\s\S]*?[.!?…](?=\s|$)["')\]]*\s*/; // the first complete sentence in a buffer

function createVoiceSession({ system, model = 'haiku', spawnFn = spawn, cwd = os.tmpdir(), turnTimeoutMs = 25000, firstTokenMs = 9000, extraArgs = [], warm = true } = {}) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--model', model, '--effort', 'low', '--no-session-persistence', '--strict-mcp-config', '--tools', '', ...extraArgs, '--system-prompt', system];
  const c = spawnFn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, SM_ROLE: 'auditor' } });
  let dead = false; c.on('error', () => { dead = true; }); c.on('close', () => { dead = true; for (const t of queue.splice(0)) t.done(null); if (cur) cur.done(null); });
  const queue = []; let cur = null; let buf = '';

  c.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!cur) continue;
      if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && typeof j.event.delta?.text === 'string') cur.feed(j.event.delta.text);
      else if (j.type === 'result') { const t = cur; cur = null; t.finish(j.is_error ? null : String(j.result ?? '')); next(); }
    }
  });

  function next() {
    if (cur || !queue.length || dead) return;
    cur = queue.shift();
    cur.start();
    try { c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: cur.text } }) + '\n'); } catch { cur.done(null); cur = null; }
  }

  /** One turn. Resolves to { say, action, ...fields, streamed: true } or null (dead session / timeout / error). */
  function ask(text, { onSentence, stale } = {}) {
    return new Promise((resolve) => {
      let pending = ''; let spoken = ''; let full = ''; let cut = false; let timer = null; let firstTimer = null;
      const t = {
        text: String(text),
        // A stalled turn (Claude not answering: 464s once, 2026-11-01) must never block the call: no first words within
        // firstTokenMs, or no end within turnTimeoutMs → the session is shut down and the caller falls back.
        start() { timer = setTimeout(() => stall(), turnTimeoutMs); timer.unref?.(); firstTimer = setTimeout(() => { if (!full) stall(); }, firstTokenMs); firstTimer.unref?.(); },
        done(v) { clearTimeout(timer); clearTimeout(firstTimer); resolve(v); },
        feed(delta) {
          full += delta; if (cut) return;
          pending += delta;
          const k = pending.search(/(^|\n)\s*ACTION\s*:/); // the action line is never spoken
          let say = k >= 0 ? pending.slice(0, k) : pending;
          if (k >= 0) cut = true;
          let m;
          while ((m = say.match(SENTENCE))) { emit(m[0]); say = say.slice(m[0].length); }
          pending = cut ? '' : say;
          if (cut && say.trim()) emit(say);
        },
        finish(result) {
          const textOut = result ?? full;
          if (!cut && pending.trim()) emit(pending);
          const am = String(textOut).match(/(?:^|\n)\s*ACTION\s*:\s*(\{[\s\S]*\})\s*$/);
          let act = {}; if (am) { try { act = JSON.parse(am[1]); } catch { act = {}; } }
          const say = (am ? String(textOut).slice(0, am.index) : String(textOut)).replace(/\s+/g, ' ').trim();
          t.done(result === null ? null : { ...act, say: say || spoken.trim(), action: act.action || 'none', streamed: !!spoken.trim() });
        },
      };
      const emit = (s) => { const x = s.replace(/\s+/g, ' ').trim(); if (!x) return; spoken += `${x} `; if (!stale?.()) { try { onSentence?.(x); } catch { /* the caller's problem */ } } };
      if (dead) return resolve(null);
      queue.push(t); next();
    });
  }
  // Warm-up: one silent turn as the call opens, so the (large) system prompt is already cached when the owner first
  // speaks. Measured: first turn ~2.0s cold vs ~1.2-1.4s once cached.
  if (warm) ask('[The call is connecting. Reply with only: ok]', { stale: () => true }).catch?.(() => {});
  function stall() { if (dead) return; dead = true; try { c.kill(); } catch { /* gone */ } const t = cur; cur = null; if (t) t.done(null); for (const q of queue.splice(0)) q.done(null); }
  const close = () => { dead = true; try { c.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 2000).unref?.(); };
  return { ask, close, get alive() { return !dead; } };
}

module.exports = { createVoiceSession, SENTENCE };
