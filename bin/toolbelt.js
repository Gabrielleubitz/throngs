'use strict';
/**
 * Owner's day-to-day toolbelt, ported from jarvis-notch (no Swift, no AI): currency conversion, weather, file shelf,
 * clipboard history, Apple Calendar upcoming, and the whatsapp-mcp-ai daemon glance (Gmail today, tracked packages).
 * Personal state lives in office/ (gitignored): jarvis.json (daemon url + secret), shelf/, clipboard.json.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DAEMON_ENV = (root) => path.join(root, '..', 'whatsapp-mcp-ai', '.env');

function createToolbelt(root, { fetchFn = (...a) => fetch(...a), run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: cmd === 'osascript' ? 60000 : 8000 }, (e, out, err) => (e ? rej(new Error(String(err || e.message).split('\n').pop() || e.message)) : res(String(out))))), now = () => Date.now() } = {}) {
  const dir = path.join(root, 'office');
  const jFile = path.join(dir, 'jarvis.json'), cFile = path.join(dir, 'clipboard.json'), shelfDir = path.join(dir, 'shelf');
  const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJ = (f, v, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), mode ? { mode } : undefined); };
  const getJson = async (url, opts) => { const r = await fetchFn(url, { ...opts, signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

  /** `sm convert 100 usd ils` */
  async function convert(amount, from, to) {
    const n = Number(amount); const f = String(from || '').toUpperCase(), t = String(to || '').toUpperCase();
    if (!Number.isFinite(n) || !/^[A-Z]{3}$/.test(f) || !/^[A-Z]{3}$/.test(t)) throw new Error('usage: sm convert <amount> <FROM> <TO>  e.g. sm convert 100 usd ils');
    const j = await getJson(`https://open.er-api.com/v6/latest/${f}`);
    const rate = j.rates && j.rates[t]; if (!rate) throw new Error(`no rate for ${f}→${t}`);
    return { amount: n, from: f, to: t, rate, result: Math.round(n * rate * 100) / 100 };
  }

  /** Weather via open-meteo (the same free source jarvis uses); default city Tel Aviv. */
  async function weather(city = 'Tel Aviv') {
    const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
    const p = g.results && g.results[0]; if (!p) throw new Error(`city not found: ${city}`);
    const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`);
    const c = w.current || {}, d = w.daily || {};
    return { city: p.name, temp: c.temperature_2m, feels: c.apparent_temperature, wind: c.wind_speed_10m, sky: wmo(c.weather_code), high: d.temperature_2m_max?.[0], low: d.temperature_2m_min?.[0], rain: d.precipitation_probability_max?.[0] };
  }
  const wmo = (c) => (c === 0 ? 'clear' : c <= 3 ? 'partly cloudy' : c <= 48 ? 'fog' : c <= 67 ? 'rain' : c <= 77 ? 'snow' : c <= 82 ? 'showers' : c >= 95 ? 'thunderstorm' : 'mixed');
  const weatherLine = (w) => `${w.city}: ${Math.round(w.temp)}° ${w.sky}, ${Math.round(w.low)}–${Math.round(w.high)}°${w.rain != null ? `, ${w.rain}% rain` : ''}`;

  /** File shelf: park files you'll need again (copies into office/shelf). */
  const shelf = {
    list: () => { try { return fs.readdirSync(shelfDir).filter((f) => !f.startsWith('.')).map((f) => ({ name: f, size: fs.statSync(path.join(shelfDir, f)).size })); } catch { return []; } },
    add(file) { const src = path.resolve(file); if (!fs.statSync(src).isFile()) throw new Error('not a file'); fs.mkdirSync(shelfDir, { recursive: true }); fs.copyFileSync(src, path.join(shelfDir, path.basename(src))); return path.join(shelfDir, path.basename(src)); },
    remove(name) { const p = path.join(shelfDir, path.basename(String(name))); fs.unlinkSync(p); return true; },
  };

  /** Clipboard history: `sm clip save` snapshots the current clipboard; list shows the last 30 (newest first). */
  const clip = {
    list: () => readJ(cFile, []),
    async save() {
      const text = (await run('pbpaste', [])).slice(0, 4000); if (!text.trim()) return null;
      const h = readJ(cFile, []); if (h[0] && h[0].text === text) return h[0];
      const e = { at: new Date(now()).toISOString(), text }; writeJ(cFile, [e, ...h].slice(0, 30)); return e;
    },
  };

  /** Apple Calendar events in the next `hours` hours (macOS only, asks for Calendar access on first use). */
  async function calendar(hours = 24) {
    const script = `set out to ""
set t0 to current date
set t1 to t0 + (${Math.max(1, Math.min(168, Number(hours) || 24))} * hours)
tell application "Calendar"
  repeat with c in calendars
    repeat with e in (every event of c whose start date ≥ t0 and start date ≤ t1)
      set out to out & (start date of e as «class isot» as string) & "|" & (summary of e) & linefeed
    end repeat
  end repeat
end tell
return out`;
    try { await run('open', ['-g', '-a', 'Calendar']); await new Promise((r) => setTimeout(r, 1500)); } catch { /* osascript reports the real error */ }
    const out = await run('osascript', ['-e', script]);
    return out.split('\n').filter(Boolean).map((l) => { const [when, ...t] = l.split('|'); return { when, title: t.join('|') }; }).sort((a, b) => a.when.localeCompare(b.when));
  }

  /** The daemon (whatsapp-mcp-ai): link copies ONLY WHATSAPP_SERVICE_SECRET + the service URL out of its .env into office/jarvis.json (0600, gitignored). */
  function link(envFile = DAEMON_ENV(root)) {
    const env = fs.readFileSync(envFile, 'utf8'); const pick = (k) => { const m = env.match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
    const secret = pick('WHATSAPP_SERVICE_SECRET'); if (!secret) throw new Error('WHATSAPP_SERVICE_SECRET not found in ' + envFile);
    writeJ(jFile, { url: pick('PUBLIC_SERVICE_URL') || 'http://127.0.0.1:3847', secret }, 0o600);
    return { url: readJ(jFile, {}).url };
  }
  const linked = () => { const j = readJ(jFile, null); return !!(j && j.secret); };
  async function daemon(p) { const j = readJ(jFile, null); if (!j || !j.secret) throw new Error('not linked: run `sm jarvis link`'); return getJson(j.url.replace(/\/$/, '') + p, { headers: { Authorization: `Bearer ${j.secret}` } }); }
  const mailToday = async (limit = 8) => (await daemon(`/jarvis/gmail/today?limit=${Number(limit) || 8}`)).messages || [];
  async function tracking() { const j = await daemon('/jarvis/tracking/summary'); return { packages: j.packages || [], subscriptions: j.subscriptions || [], flights: j.flights || [] }; }

  return { convert, weather, weatherLine, shelf, clip, calendar, link, linked, mailToday, tracking };
}
module.exports = { createToolbelt };
