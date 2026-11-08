/**
 * ElevenLabs text-to-speech for the office crew. The key lives in `<root>/.env` (ELEVENLABS_API_KEY, optional
 * ELEVENLABS_VOICE_ID / ELEVENLABS_MODEL_ID) and never leaves the server: the browser asks /sm/voice/speak for audio.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel", a stock ElevenLabs voice
const DEFAULT_MODEL = 'eleven_turbo_v2_5';
const MAX_CHARS = 600;

/** Parse KEY=VALUE lines (quotes and `#` comments allowed). */
function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function createVoice(root, { fetchFn = globalThis.fetch } = {}) {
  // read each call so the owner can drop the key in without restarting the office
  const cfg = () => {
    let file = {};
    try { file = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')); } catch { /* no .env yet */ }
    return { key: file.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY || '', voice: file.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE, model: file.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL };
  };
  const status = () => ({ enabled: !!cfg().key });

  /** @returns {Promise<{audio: Buffer, type: string}>} */
  async function speak(body, { maxChars = MAX_CHARS } = {}) {
    const text = String(body?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (!text) throw Object.assign(new Error('text required'), { status: 400 });
    const c = cfg();
    if (!c.key) throw Object.assign(new Error('Voice is off: add ELEVENLABS_API_KEY to the .env file.'), { status: 503 });
    const voice = /^[A-Za-z0-9]{10,40}$/.test(String(body?.voice ?? '')) ? body.voice : c.voice;
    const r = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': c.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: c.model }),
    });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j?.detail?.message || j?.detail?.status || ''; } catch { /* not json */ }
      throw Object.assign(new Error(`ElevenLabs said ${r.status}${detail ? `: ${detail}` : ''}`), { status: r.status === 401 ? 401 : 502 });
    }
    return { audio: Buffer.from(await r.arrayBuffer()), type: 'audio/mpeg' };
  }
  /** Narration for a video: write the mp3 to `out` (the key stays here; the video worker only gets the file). */
  async function voiceover(text, out, voice) {
    const { audio } = await speak({ text, voice }, { maxChars: 4000 });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, audio);
    return { file: path.resolve(out), bytes: audio.length };
  }
  return { status, speak, voiceover, voiceId: () => cfg().voice };
}

module.exports = { createVoice, parseEnv, DEFAULT_VOICE };
