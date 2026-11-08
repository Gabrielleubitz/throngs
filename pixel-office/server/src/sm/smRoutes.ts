/**
 * Success Manager bridge — the one place this fork knows about success-manager.
 *
 * Enabled only when SM_ROOT points at a success-manager checkout (`sm office` sets it). Exposes its
 * read/act API under /sm/* with the same Bearer token that guards hooks, so only the tokened page
 * the CLI printed can read tasks or launch reviewers.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { MAX_UPLOAD_BYTES, saveImage } from './uploads.js';

interface SmApi {
  projects(): unknown;
  health(): unknown;
  officeBusy(): boolean;
  state(name: string): unknown;
  diff(name: string): string;
  audit(body: unknown): unknown;
  human(body: unknown): unknown;
  fix(body: unknown): unknown;
  folders(base?: string): unknown;
  setAccess(body: unknown): unknown;
  staff: { list(): unknown; saveRoom(b: unknown): unknown; update(b: unknown): unknown; hire(b: unknown): unknown; fire(b: unknown): unknown };
  addProject(body: unknown): unknown;
  standup: { latest(): unknown; startDaily(): unknown };
  devpulse: { current(maxAgeMs?: number): unknown; refresh(): Promise<unknown>; attention(d?: unknown): unknown };
  ivyDay: { start(everyMs?: number): void };
  glance(): Promise<unknown>;
  wellbeing: { state(): unknown; awakeOn(hours?: number): unknown; awakeOff(): unknown; setBreaks(o: unknown): unknown };
  focus: { get(): unknown; set(b: unknown): unknown };
  calendar: { events(q: unknown): Promise<unknown>; meet(b: unknown): Promise<unknown>; linked(): unknown };
  accounts: { start(): void; snapshot(): unknown; tick(): unknown };
  watch: { start(everyMs?: number): void; latest(): unknown; run(o?: { fix?: boolean }): unknown };
  errorlog: { start(getWatch?: () => unknown): void; record(e: unknown): unknown; list(): unknown; approve(id: string, project?: string): unknown; dismiss(id: string): unknown };
  learning: { add(text: string, o?: { kind?: string; source?: string }): unknown; list(): unknown; remove(id: string): unknown };
  integrations: { list(): unknown; save(b: unknown): unknown; clear(b: unknown): unknown; oauthStart(b: unknown): unknown; oauthCallback(q: unknown): Promise<{ id: string; name: string }> };
  firebase: { status(): unknown; link(key: unknown): unknown; unlink(): unknown; push(pass: string): Promise<unknown>; pull(pass: string): Promise<unknown> };
  onboarding: { status(): unknown; complete(): unknown; reset(): unknown; video(): { file: string; type: string; size: number } };
  voice: { status(): unknown; speak(b: unknown): Promise<{ audio: Buffer; type: string }> };
  secretary: Record<string, (...a: never[]) => unknown>;
  phone: { serve(): unknown; status(): unknown; call(text: string, o?: { to?: string }): Promise<unknown> };
  meetings: { join(b: unknown): unknown; end(b: unknown): unknown; comment(b: unknown): unknown; dropNote(b: unknown): unknown; reveal(b: unknown): unknown; pdf(project: string, id: string): { file: string; type: string; size: number }; video(project: string, id: string): { file: string; type: string; size: number } };
  ideas: { list(project: string): unknown; thoughts(b: unknown): unknown; dismiss(b: unknown): unknown; fresh(b: unknown): unknown; givePlanner(b: unknown): unknown };
  mission: {
    create(body: unknown): unknown;
    answer(body: unknown): unknown;
    reply(body: unknown): unknown;
    diff(project: string, mission: string): unknown;
    stream(project: string, mission: string, subtask: string, since?: number): unknown;
    cancel(body: unknown): unknown;
    resume(body: unknown): unknown;
    reorder(body: unknown): unknown;
    sendNow(body: unknown): unknown;
  };
}

function loadSmApi(root: string): SmApi | null {
  try {
    const req = createRequire(__filename);
    const sm = req(path.join(root, 'bin', 'sm.js'));
    const { createApi } = req(path.join(root, 'bin', 'sm-api.js'));
    const api = createApi(sm) as SmApi;
    api.phone.serve(); // public surface for Twilio: audio clips + signed WhatsApp webhook only
    return api;
  } catch (err) {
    console.error(`[Pixel Agents] Success Manager bridge disabled: ${(err as Error).message}`);
    return null;
  }
}

export function registerSmRoutes(
  app: FastifyInstance,
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  const root = process.env.SM_ROOT;
  if (!root) return;
  const api = loadSmApi(root);
  if (!api) return;
  console.log(`[Pixel Agents] Success Manager bridge on: ${root}`);
  api.standup.startDaily(); // morning standup note, once per day
  api.ivyDay.start(); // IVY: reminders fire, the morning brief goes out on WhatsApp, the dev pulse stays fresh
  api.accounts.start(); // non-AI cswap watcher: switches Claude accounts, keeps the top-bar usage numbers fresh
  api.errorlog.start(() => (api.watch.latest() as { findings?: unknown[] }).findings ?? []); // TRACE: error-log bot; fixes wait for the owner's approval
  api.watch.start(); // ARES's watch: health checks every 10 min with safe fixes (also runs after every mission)

  const run = async (reply: FastifyReply, fn: () => unknown) => {
    try {
      return reply.send(await fn()); // await: async handlers' errors must reach the catch, not vanish
    } catch (err) {
      const e = err as Error & { status?: number; fixUrl?: string };
      if (!e.status || e.status >= 500) { try { api.errorlog.record({ source: 'request', title: `Request failed: ${e.message}`, detail: e.stack }); } catch { /* ignore */ } } // 4xx = the owner's mistake, not an office bug
      return reply.code(e.status ?? 500).send({ error: e.message, ...(e.fixUrl ? { fixUrl: e.fixUrl } : {}) });
    }
  };
  const project = (request: FastifyRequest) =>
    String((request.query as Record<string, string> | undefined)?.project ?? '');

  // Image attachments: base64 JSON (the app-wide body limit is far too small for pictures)
  app.post('/sm/upload', { preHandler: auth, bodyLimit: MAX_UPLOAD_BYTES * 2 }, async (req, reply) =>
    run(reply, () => saveImage(root, req.body)));
  app.get('/sm/enabled', { preHandler: auth }, async (_req, reply) => reply.send({ ok: true }));
  // Which office build is on disk right now — open tabs reload themselves when a mission ships a new one.
  const webIndex = path.join(root, 'pixel-office', 'dist', 'webview', 'index.html');
  app.get('/sm/build', { preHandler: auth }, async (_req, reply) => {
    let busy = false;
    try { busy = api.officeBusy(); } catch { /* treat as idle */ }
    try { return reply.send({ id: String(fs.statSync(webIndex).mtimeMs), busy }); } catch { return reply.send({ id: '', busy }); }
  });
  app.get('/sm/accounts', { preHandler: auth }, async (_req, reply) => run(reply, () => api.accounts.snapshot()));
  app.get('/sm/errors', { preHandler: auth }, async (_req, reply) => run(reply, () => api.errorlog.list()));
  app.post('/sm/errors', { preHandler: auth }, async (req, reply) => run(reply, () => api.errorlog.record({ ...(req.body as object), source: 'ui' })));
  app.post('/sm/errors/approve', { preHandler: auth }, async (req, reply) => run(reply, () => { const b = req.body as { id: string; project?: string }; return api.errorlog.approve(b.id, b.project); }));
  app.post('/sm/errors/dismiss', { preHandler: auth }, async (req, reply) => run(reply, () => api.errorlog.dismiss((req.body as { id: string }).id)));
  app.get('/sm/learnings', { preHandler: auth }, async (_req, reply) => run(reply, () => api.learning.list()));
  app.post('/sm/learnings', { preHandler: auth }, async (req, reply) => run(reply, () => { const b = req.body as { text: string; kind?: string }; return api.learning.add(b.text, { kind: b.kind, source: 'owner' }); }));
  app.post('/sm/learnings/remove', { preHandler: auth }, async (req, reply) => run(reply, () => api.learning.remove((req.body as { id: string }).id)));
  app.get('/sm/watch', { preHandler: auth }, async (_req, reply) => run(reply, () => api.watch.latest()));
  app.post('/sm/watch/run', { preHandler: auth }, async (_req, reply) => run(reply, () => api.watch.run({ fix: true })));
  app.post('/sm/accounts/refresh', { preHandler: auth }, async (_req, reply) => run(reply, () => api.accounts.tick()));
  app.get('/sm/projects', { preHandler: auth }, async (_req, reply) => run(reply, () => api.projects()));
  app.get('/sm/health', { preHandler: auth }, async (_req, reply) => run(reply, () => api.health()));
  app.get('/sm/state', { preHandler: auth }, async (req, reply) => run(reply, () => api.state(project(req))));
  app.get('/sm/diff', { preHandler: auth }, async (req, reply) => run(reply, () => ({ diff: api.diff(project(req)) })));
  app.post('/sm/audit', { preHandler: auth }, async (req, reply) => run(reply, () => api.audit(req.body)));
  app.post('/sm/fix', { preHandler: auth }, async (req, reply) => run(reply, () => api.fix(req.body)));
  app.post('/sm/human', { preHandler: auth }, async (req, reply) => run(reply, () => api.human(req.body)));
  app.get('/sm/folders', { preHandler: auth }, async (req, reply) =>
    run(reply, () => api.folders((req.query as Record<string, string> | undefined)?.base)));
  app.post('/sm/project/access', { preHandler: auth }, async (req, reply) => run(reply, () => api.setAccess(req.body)));
  app.post('/sm/project/add', { preHandler: auth }, async (req, reply) => run(reply, () => api.addProject(req.body)));
  // Company roster: rooms (department briefs) + staff (titles, briefs, hires)
  app.get('/sm/standup', { preHandler: auth }, async (_req, reply) => run(reply, () => api.standup.latest()));
  app.get('/sm/staff', { preHandler: auth }, async (_req, reply) => run(reply, () => api.staff.list()));
  app.post('/sm/staff/room', { preHandler: auth }, async (req, reply) => run(reply, () => api.staff.saveRoom(req.body)));
  app.post('/sm/staff/update', { preHandler: auth }, async (req, reply) => run(reply, () => api.staff.update(req.body)));
  app.post('/sm/staff/hire', { preHandler: auth }, async (req, reply) => run(reply, () => api.staff.hire(req.body)));
  // Future Ideas (MUSE): always 5 suggestions
  app.get('/sm/ideas', { preHandler: auth }, async (req, reply) => run(reply, () => api.ideas.list(project(req))));
  app.post('/sm/ideas/fresh', { preHandler: auth }, async (req, reply) => run(reply, () => api.ideas.fresh(req.body)));
  app.post('/sm/ideas/thoughts', { preHandler: auth }, async (req, reply) => run(reply, () => api.ideas.thoughts(req.body)));
  app.post('/sm/ideas/dismiss', { preHandler: auth }, async (req, reply) => run(reply, () => api.ideas.dismiss(req.body)));
  app.post('/sm/ideas/give-planner', { preHandler: auth }, async (req, reply) => run(reply, () => api.ideas.givePlanner(req.body)));
  app.post('/sm/staff/fire', { preHandler: auth }, async (req, reply) => run(reply, () => api.staff.fire(req.body)));
  // Zoo integrations (keys are masked on the way out; `get` is CLI-only)
  app.get('/sm/integrations', { preHandler: auth }, async (_req, reply) => run(reply, () => api.integrations.list()));
  app.post('/sm/integrations/save', { preHandler: auth }, async (req, reply) => run(reply, () => api.integrations.save(req.body)));
  app.post('/sm/integrations/clear', { preHandler: auth }, async (req, reply) => run(reply, () => api.integrations.clear(req.body)));
  // Click-to-sign-in: start (tokened) -> provider consent -> callback (no token: the provider's redirect; guarded by a one-time state)
  app.post('/sm/integrations/oauth/start', { preHandler: auth }, async (req, reply) => {
    // Google only accepts the one redirect the owner registered (127.0.0.1), so never send localhost.
    const origin = `${req.protocol}://${String(req.headers.host).replace(/^localhost(?=[:/]|$)/i, '127.0.0.1')}`;
    return run(reply, () => api.integrations.oauthStart({ ...(req.body as object), redirect: `${origin}/sm/oauth/callback` }));
  });
  app.get('/sm/oauth/callback', async (req, reply) => {
    const page = (ok: boolean, msg: string) => reply.header('Content-Type', 'text/html; charset=utf-8').code(ok ? 200 : 400)
      .send(`<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="font:16px monospace;background:#1e1e2e;color:#fff;padding:40px"><h2>${ok ? '✅' : '⚠️'} ${msg.replace(/[<&]/g, '')}</h2><p>You can close this tab and go back to the office.</p><script>try{window.opener&&window.opener.postMessage('sm-oauth','*')}catch(e){}${ok ? "setTimeout(()=>{if(window.opener)window.close();else{var r=sessionStorage.getItem('smReturn');if(r)location.href=r}},1500)" : ''}</script>`);
    try {
      const r = await api.integrations.oauthCallback(req.query);
      return page(true, `${r.name} is signed in`);
    } catch (err) {
      return page(false, (err as Error).message);
    }
  });
  // First-run onboarding + Firebase backup
  app.get('/sm/onboarding', { preHandler: auth }, async (_req, reply) => run(reply, () => api.onboarding.status()));
  app.post('/sm/onboarding/complete', { preHandler: auth }, async (_req, reply) => run(reply, () => api.onboarding.complete()));
  app.post('/sm/onboarding/reset', { preHandler: auth }, async (_req, reply) => run(reply, () => api.onboarding.reset()));
  app.get('/sm/onboarding/video', { preHandler: auth }, async (_req, reply) => {
    try {
      const v = api.onboarding.video();
      return reply.header('Content-Type', v.type).header('Content-Length', String(v.size)).send(fs.createReadStream(v.file));
    } catch (err) {
      const e = err as Error & { status?: number };
      return reply.code(e.status ?? 500).send({ error: e.message });
    }
  });
  app.get('/sm/firebase', { preHandler: auth }, async (_req, reply) => run(reply, () => api.firebase.status()));
  app.post('/sm/firebase/link', { preHandler: auth }, async (req, reply) => run(reply, () => api.firebase.link((req.body as { key?: unknown } | undefined)?.key)));
  app.post('/sm/firebase/unlink', { preHandler: auth }, async (_req, reply) => run(reply, () => api.firebase.unlink()));
  app.post('/sm/firebase/push', { preHandler: auth }, async (req, reply) => {
    try {
      return reply.send(await api.firebase.push(String((req.body as { passphrase?: string } | undefined)?.passphrase ?? '')));
    } catch (err) {
      const e = err as Error & { status?: number };
      return reply.code(e.status ?? 500).send({ error: e.message });
    }
  });
  app.post('/sm/firebase/pull', { preHandler: auth }, async (req, reply) => {
    try {
      return reply.send(await api.firebase.pull(String((req.body as { passphrase?: string } | undefined)?.passphrase ?? '')));
    } catch (err) {
      const e = err as Error & { status?: number };
      return reply.code(e.status ?? 500).send({ error: e.message });
    }
  });
  // ElevenLabs voice for the crew (key stays in .env on the server)
  app.get('/sm/voice', { preHandler: auth }, async (_req, reply) => run(reply, () => api.voice.status()));
  app.post('/sm/voice/speak', { preHandler: auth }, async (req, reply) => {
    try {
      const v = await api.voice.speak(req.body);
      return reply.header('Content-Type', v.type).header('Cache-Control', 'private, max-age=3600').send(v.audio);
    } catch (err) {
      const e = err as Error & { status?: number };
      return reply.code(e.status ?? 500).send({ error: e.message });
    }
  });
  // ARES on the phone (Twilio + ElevenLabs): status, and "call me" with something to say
  // The owner's dev pulse: local repos + GitHub, ranked (bin/devpulse.js). POST refreshes now.
  // Where the office is working (shared: the UI follows it, IVY moves it from Telegram/phone)
  // The owner's Google Calendar in the office (bin/google.js): read, and new meetings with a Meet link
  app.get('/sm/calendar', { preHandler: auth }, async (req, reply) => run(reply, () => api.calendar.events(req.query)));
  app.post('/sm/calendar/meet', { preHandler: auth }, async (req, reply) => run(reply, () => api.calendar.meet(req.body)));
  app.get('/sm/focus', { preHandler: auth }, async (_req, reply) => run(reply, () => api.focus.get()));
  app.post('/sm/focus', { preHandler: auth }, async (req, reply) => run(reply, () => api.focus.set({ ...(req.body as object), by: 'owner' })));
  app.get('/sm/pulse', { preHandler: auth }, async (_req, reply) => run(reply, () => { const d = api.devpulse.current(); return { ...(d as object), attention: api.devpulse.attention(d) }; }));
  app.post('/sm/pulse', { preHandler: auth }, async (_req, reply) => run(reply, async () => { const d = await api.devpulse.refresh(); return { ...(d as object), attention: api.devpulse.attention(d) }; }));
  app.get('/sm/phone', { preHandler: auth }, async (_req, reply) => run(reply, () => api.phone.status()));
  app.post('/sm/phone/call', { preHandler: auth }, async (req, reply) => run(reply, () => api.phone.call(String((req.body as { text?: unknown } | undefined)?.text ?? ''))));
  // IVY's desk (secretary): tasks, knowledge, missed-while-away checklist, callbacks, digest
  const body = (req: { body?: unknown }) => (req.body ?? {}) as Record<string, unknown>;
  const sec = (name: string, req: { body?: unknown }) => (api.secretary[name] as (b: unknown) => unknown)(body(req));
  app.get('/sm/secretary', { preHandler: auth }, async (_req, reply) => run(reply, () => (api.secretary.state as () => unknown)()));
  for (const name of ['addTask', 'setTask', 'removeTask', 'addNote', 'removeNote', 'addContact', 'removeContact', 'importContacts', 'tick', 'tickAll', 'sendDigest', 'markReturn', 'addReminder', 'removeReminder', 'briefSettings', 'sendBrief', 'previewBrief']) {
    app.post(`/sm/secretary/${name}`, { preHandler: auth }, async (req, reply) => run(reply, () => sec(name, req)));
  }
  // Day glance (from jarvis-notch): weather + Gmail today + tracked packages
  app.get('/sm/glance', { preHandler: auth }, async (_req, reply) => run(reply, () => api.glance()));
  // Wellbeing (from jarvis-notch): keep the Mac awake, IVY's break nudges. Only the owner switches them on.
  app.get('/sm/wellbeing', { preHandler: auth }, async (_req, reply) => run(reply, () => api.wellbeing.state()));
  app.post('/sm/wellbeing/awake', { preHandler: auth }, async (req, reply) => run(reply, () => { const b = body(req); if (b.on) api.wellbeing.awakeOn(b.hours as number | undefined); else api.wellbeing.awakeOff(); return api.wellbeing.state(); }));
  app.post('/sm/wellbeing/breaks', { preHandler: auth }, async (req, reply) => run(reply, () => { api.wellbeing.setBreaks(body(req)); return api.wellbeing.state(); }));
  // Conference-room meetings (a finished video calls the owner in)
  app.post('/sm/meeting/join', { preHandler: auth }, async (req, reply) => run(reply, () => api.meetings.join(req.body)));
  app.post('/sm/meeting/end', { preHandler: auth }, async (req, reply) => run(reply, () => api.meetings.end(req.body)));
  app.post('/sm/meeting/comment', { preHandler: auth }, async (req, reply) => run(reply, () => api.meetings.comment(req.body)));
  app.post('/sm/meeting/note/drop', { preHandler: auth }, async (req, reply) => run(reply, () => api.meetings.dropNote(req.body)));
  app.post('/sm/meeting/reveal', { preHandler: auth }, async (req, reply) => run(reply, () => api.meetings.reveal(req.body)));
  app.get('/sm/meeting/video', { preHandler: auth }, async (req, reply) => {
    const q = (req.query as Record<string, string> | undefined) ?? {};
    try {
      const v = api.meetings.video(q.project ?? '', q.id ?? '');
      return reply.header('Content-Type', v.type).header('Content-Length', String(v.size)).send(fs.createReadStream(v.file));
    } catch (err) {
      const e = err as Error & { status?: number };
      return reply.code(e.status ?? 500).send({ error: e.message });
    }
  });
  app.get('/sm/meeting/pdf', { preHandler: auth }, async (req, reply) => {
    const q = (req.query as Record<string, string> | undefined) ?? {};
    try {
      const v = api.meetings.pdf(q.project ?? '', q.id ?? '');
      return reply.header('Content-Type', v.type).header('Content-Length', String(v.size)).send(fs.createReadStream(v.file));
    } catch (err) {
      const e = err as Error & { status?: number };
      return reply.code(e.status ?? 500).send({ error: e.message });
    }
  });
  // Floor Manager missions
  app.post('/sm/mission/create', { preHandler: auth }, async (req, reply) => run(reply, () => api.mission.create(req.body)));
  app.post('/sm/mission/answer', { preHandler: auth }, async (req, reply) => run(reply, () => api.mission.answer(req.body)));
  app.get('/sm/mission/stream', { preHandler: auth }, async (req, reply) =>
    run(reply, () => { const q = (req.query as Record<string, string> | undefined) ?? {}; return api.mission.stream(q.project ?? '', q.mission ?? '', q.subtask ?? '', Number(q.since) || 0); }));
  app.get('/sm/mission/diff', { preHandler: auth }, async (req, reply) =>
    run(reply, () => { const q = (req.query as Record<string, string> | undefined) ?? {}; return api.mission.diff(q.project ?? '', q.mission ?? ''); }));
  app.post('/sm/mission/reply', { preHandler: auth }, async (req, reply) => run(reply, () => api.mission.reply(req.body)));
  app.post('/sm/mission/cancel', { preHandler: auth }, async (req, reply) => run(reply, () => api.mission.cancel(req.body)));
  app.post('/sm/mission/resume', { preHandler: auth }, async (req, reply) => run(reply, () => api.mission.resume(req.body)));
  app.post('/sm/mission/reorder', { preHandler: auth }, async (req, reply) => run(reply, () => api.mission.reorder(req.body)));
  app.post('/sm/mission/send-now', { preHandler: auth }, async (req, reply) => run(reply, () => api.mission.sendNow(req.body)));
}
