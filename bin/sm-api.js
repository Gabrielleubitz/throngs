/**
 * Success Manager read/act API shared by `sm dashboard` and the Pixel Office fork (pixel-office/).
 * Pure functions over sm.js internals; no HTTP here.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const AGENTS = ['code', 'ui', 'ux', 'functionality', 'marketing'];
const isHumanTask = (i) => i.labels.includes('human') || i.labels.includes('escalated');
/** Filed by one of the reviewer agents (label `src:audit-<agent>`), as opposed to Slack/manual intake. */
const isReviewTask = (i) => (i.labels || []).some((l) => l.startsWith('src:audit-')); // hired reviewers get their own suffix

/**
 * "Explain it like I'm 5" for a human task. Stored in projects/<name>/asks.json as
 * { [taskId]: { what, why, steps: [], doneWhen, reply } }, or written by an agent in the task's
 * notes as an `ASK:` block (one line each: what/why/step/done/reply).
 */
function parseAskNotes(notes) {
  const m = String(notes || '').match(/ASK:([\s\S]*?)(?:\n\s*\n|$)/);
  if (!m) return null;
  const ask = { steps: [] };
  for (const line of m[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [k, ...v] = line.split(':');
    const val = v.join(':').trim();
    const key = k.toLowerCase().replace(/^- /, '');
    if (key === 'what') ask.what = val;
    else if (key === 'why') ask.why = val;
    else if (key === 'step') ask.steps.push(val);
    else if (key === 'done') ask.doneWhen = val;
    else if (key === 'reply') ask.reply = val;
  }
  return ask.what ? ask : null;
}

function createApi(sm) {
  const { ROOT, SELF, loadProject, listProjects, isRunning, overallStatus, usesBeads, bd, readJSON } = sm;
  const M = require('./missions.js').createMissions(sm);
  const staffApi = require('./staff.js').createStaff(ROOT);
  const wellbeing = require('./wellbeing.js').createWellbeing(ROOT);
  const toolbelt = require('./toolbelt.js').createToolbelt(ROOT);
  /** Day glance for the Today tab: each piece fails on its own (no daemon / offline) and just goes missing. */
  const glance = async () => { const ok = async (f) => { try { return await f(); } catch { return null; } }; const [w, m, t] = await Promise.all([ok(() => toolbelt.weather()), toolbelt.linked() ? ok(() => toolbelt.mailToday(5)) : null, toolbelt.linked() ? ok(() => toolbelt.tracking()) : null]); return { weather: w ? toolbelt.weatherLine(w) : null, linked: toolbelt.linked(), mail: m ? m.map((x) => ({ from: String(x.from || x.sender || '').replace(/<.*>/, '').trim(), subject: x.subject || '' })) : null, packages: t ? t.packages.length : null, flights: t ? t.flights.length : null }; };
  const voice = require('./voice.js').createVoice(ROOT);
  const integrations = require('./integrations.js').createIntegrations(ROOT);
  const ivyGoogle = require('./ivy-google.js').createIvyGoogle(integrations); // IVY reads the linked Google Calendar + Drive
  // The owner's developer day: every local repo + GitHub (CI, PRs, alerts, unpushed work). No AI; cached, refreshed in the background.
  const devpulse = require('./devpulse.js').createDevPulse(ROOT);
  // IVY's hands in the owner's Google (Calendar, Gmail, Contacts): bin/google.js. Sends are confirmed by the owner first.
  const google = require('./google.js').createGoogle(integrations);
  // Every open question an agent has for the owner, with its project (IVY answers them by phone/Telegram).
  const askWhat = (a) => (a && typeof a === 'object' ? a.what || '' : String(a || ''));
  // Both read every project's full state (beads included: ~2s); IVY asks for them on every call turn, so they are
  // cached for 20s (a call must never wait on the office's bookkeeping).
  const memo = (fn, ms = 20000) => { let at = 0; let v; return () => { if (Date.now() - at > ms) { v = fn(); at = Date.now(); } return v; }; };
  const openQuestions = memo(() => listProjects().flatMap((n) => { try { return (state(n).questions || []).map((q) => ({ ...q, project: n })); } catch { return []; } }));
  const crewName = (id) => { try { return staffApi.load().staff.find((x) => x.id === id)?.name || ''; } catch { return ''; } };
  const allMissions = memo(() => listProjects().flatMap((n) => { try { return M.snapshot(n).map((m) => ({ project: n, id: m.id, prompt: m.prompt, status: m.status, report: m.report, updatedAt: m.updatedAt })); } catch { return []; } }));
  // Telegram is IVY's main text line when linked (bin/telegram.js); WhatsApp is the fallback.
  const telegram = require('./telegram.js').createTelegram(ROOT, { integrations });
  const notify = (text) => (telegram.linked() ? telegram.send(text) : phone.whatsapp(text));
  // ARES on the phone: the owner's WhatsApp text becomes a request for ARES ("project: text" targets a project).
  const chat = require('./ares-chat.js');
  // A caller left a message: the owner hears it on Telegram right away, not only on IVY's desk.
  // Every caller scenario has its own label; spam, wrong numbers and abusive calls are logged quietly.
  const LABEL = { lead: '🆕 New lead', delivery: '📦 Delivery', urgent: '🚨 Urgent', personal: '💬 Personal', callback: '📞 Call back', message: '📞 Message', availability: '📞 Asked for you', language: '🌐 Couldn\'t talk (language)', other: '📞 Call' };
  const callerLine = (call) => {
    const who = call.callerName ? `${call.callerName.charAt(0).toUpperCase()}${call.callerName.slice(1)}` : call.from || 'Someone';
    const l = call.lead || {};
    return [`${LABEL[call.intent] || '📞 Message'} — ${who}${l.company ? ` (${l.company})` : ''}`, call.details ? call.details : (call.messages || []).length ? `“${call.messages.join(' ').slice(0, 800)}”` : '',
      l.bestTime ? `Best time: ${l.bestTime}` : '', `Call back: ${l.contact || call.from || 'unknown'}${l.contact && call.from ? ` (called from ${call.from})` : ''}`].filter(Boolean).join('\n');
  };
  const CALLOUT_SAID = { delivered: 'delivered', confirmed: 'confirmed ✅', declined: 'declined ❌', rescheduled: 'wants to reschedule', answered: 'answered', callback: 'asked you to call back', wrong_person: 'wrong person', unclear: 'unclear' };
  const onCallEnded = (call) => {
    if (call.delegate) { // a call Ivy placed for the owner: tell them how it went
      const d = call.delegate; const who = d.name || call.from;
      const how = call.outcome === 'voicemail-left' ? 'no answer, left a voicemail' : ['no-answer', 'busy', 'failed', 'calling'].includes(call.outcome) ? `didn't pick up (${call.outcome})` : CALLOUT_SAID[d.outcome] || 'call ended';
      notify(`📞 Called ${who} — ${how}.${d.result ? `\n${d.result}` : ''}\n(You asked: ${d.message})`).catch(() => {});
      return;
    }
    if (call.isOwner) return;
    if (['spam', 'wrong-number', 'abusive'].includes(call.outcome)) return; // in the call log, no alert
    if (call.outcome === 'transferred') { notify(`☎️ Put ${call.callerName || call.from} through to you.${call.details ? `\n${call.details}` : ''}`).catch(() => {}); return; }
    if (!(call.messages || []).length && !call.details) return;
    notify(callerLine(call)).catch(() => {});
  };
  // Mid-call: a delivery at the door or an emergency is told to the owner right away.
  const onUrgent = (call) => notify(`${call.intent === 'delivery' ? '📦' : '🚨'} Right now on the phone — ${callerLine(call)}`).catch(() => {});
  const phoneSet = () => { try { return secretary.phoneSettings(); } catch { return {}; } };
  const ownerName = () => phoneSet().ownerName || String(require('child_process').spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout || '').trim().split(' ')[0] || 'the owner';
  /** Who may be put through live: urgent callers (unless 'never'), known contacts (policy 'contacts'); never in quiet hours. */
  const canTransfer = (call) => {
    const pol = phoneSet().transfer || 'contacts';
    if (pol === 'never') return false;
    try { const q = ivyTelegram.settings().quiet; if (q) { const [a, b] = q.split('-').map((x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; }); const d = new Date(); const t = d.getHours() * 60 + d.getMinutes(); if (a <= b ? t >= a && t < b : t >= a || t < b) return false; } } catch { /* no quiet hours */ }
    return call.intent === 'urgent' || (pol === 'contacts' && call.contact);
  };
  // What IVY knows about the office itself: the crew and the Claude accounts METER switches between.
  const officeInfo = () => {
    const crew = (() => { try { return staffApi.load().staff.map((x) => `${x.name} (${x.title})`).join(', '); } catch { return ''; } })();
    const s = (() => { try { return accounts.snapshot(); } catch { return null; } })();
    const acc = s?.available ? s.accounts.map((a) => `#${a.number} ${a.email}${a.active ? ' (ACTIVE)' : ''}${a.needsLogin ? ' needs re-login' : ` 5h ${Math.round(a.fiveHour.pct)}% 7d ${Math.round(a.sevenDay.pct)}%`}`).join('; ') : 'unknown';
    return [crew ? `The crew: ${crew}. METER watches the Claude accounts and switches when one runs out.` : '', `Claude accounts the office runs on (METER): ${acc}${s?.lastSwitch ? `; last switch #${s.lastSwitch.from}→#${s.lastSwitch.to} at ${new Date(s.lastSwitch.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}.`].filter(Boolean).join('\n');
  };
  const phone = require('./ares-phone.js').createPhone(ROOT, { integrations, voice, officeInfo, onCallEnded, isOff: () => !!phoneSet().off,
    delegateSession: (m) => require('./voice-brain.js').createVoiceSession({ system: chat.delegateSystem(m), model: phoneSet().voiceModel || 'haiku' }), onUrgent, canTransfer, ownerName, ownerPin: () => phoneSet().pinHash || '', callerBrain: (i) => chat.callerTurn(ROOT, i), desk: () => secretary, google: () => ivyGoogle.current(), pulse: () => devpulse.context(devpulse.current()), today: () => ivyDay.brief().spoken, onPrompt: chat.createChat({
    turn: (input) => chat.claudeTurn(ROOT, input),
    google,
    // Google sends: people Ivy remembered first; a call's draft is mirrored to Telegram (exact address + Send/Cancel);
    // after a send the names are remembered, and a bounce within ~6 minutes is reported and forgotten
    findContactEmail: (name) => secretary.emailFor(name),
    callOut: (o) => phone.callOut(o),
    onDraft: (d) => { if (String(d.thread).startsWith('call:') && telegram.linked()) ivyTelegram.mirrorDraft(d).catch(() => {}); },
    onSent: (d) => {
      const sentAt = Date.now();
      for (const p of d.people) if (p.name && p.source !== 'memory') { try { secretary.rememberEmail(p); } catch { /* best effort */ } }
      for (const delay of [90000, 360000]) setTimeout(async () => {
        for (const p of d.people) {
          try { if (!p.reported && await google.bounced(p.email, sentAt)) { p.reported = true; secretary.forgetEmail(p.email); notify(`⚠️ ${d.kind === 'meet' ? 'The invite' : 'The email'} to ${p.email} bounced: Gmail says the address doesn't exist. I've forgotten it; tell me the right one${p.name ? ` for ${p.name}` : ''}.`).catch(() => {}); } } catch { /* try next time */ }
        }
      }, delay).unref?.();
    },
    // live calls: one warm streaming session per call (bin/voice-brain.js); Haiku by default for speed (sm phone --model)
    session: (system) => require('./voice-brain.js').createVoiceSession({ system, model: phoneSet().voiceModel || 'haiku' }),
    projects: () => listProjects().filter((n) => n !== 'success-manager'),
    note: (n) => secretary.addNote(n),
    remind: (r) => secretary.addReminder(r),
    findContact: (name) => { const n = String(name).toLowerCase().trim(); const cs = secretary.knowledge().contacts; return cs.find((c) => c.name.toLowerCase() === n) || cs.find((c) => c.name.toLowerCase().split(' ')[0] === n.split(' ')[0]) || null; },
    wellbeing: (what, hours) => {
      const W = wellbeing;
      if (what === 'awake_on') { const a = W.awakeOn(hours); return `Done, your Mac stays awake until ${new Date(a.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`; }
      if (what === 'awake_off') { W.awakeOff(); return 'Done, your Mac can sleep again.'; }
      if (what === 'breaks_on') { const s = W.setBreaks({ on: true }); return `Done, I'll nudge you every ${s.everyMin} minutes between ${s.from}:00 and ${s.to}:00.`; }
      if (what === 'breaks_off') { W.setBreaks({ on: false }); return "Done, no more break reminders."; }
      throw new Error('unknown option');
    },
    lookup: async (r) => {
      if (r.lookup === 'weather') return `${toolbelt.weatherLine(await toolbelt.weather(r.city || undefined))}.`;
      if (r.lookup === 'convert') { const c = await toolbelt.convert(r.amount, r.from, r.to); return `${c.amount} ${c.from} is about ${c.result} ${c.to}.`; }
      if (r.lookup === 'mail') { const m = await toolbelt.mailToday(5); return m.length ? `${m.length} mail${m.length === 1 ? '' : 's'} today. Latest: ${m[0].subject || 'no subject'}, from ${String(m[0].from || m[0].sender || 'someone').replace(/<.*>/, '').trim()}.` : 'No mail so far today.'; }
      if (r.lookup === 'tracking') { const t = await toolbelt.tracking(); return `${t.packages.length} package${t.packages.length === 1 ? '' : 's'}, ${t.flights.length} flight${t.flights.length === 1 ? '' : 's'}, ${t.subscriptions.length} subscription${t.subscriptions.length === 1 ? '' : 's'} tracked.`; }
      if (r.lookup === 'calendar') { const e = await toolbelt.calendar(24); return e.length ? `${e.length} on your calendar: ${e.slice(0, 3).map((x) => `${x.when.slice(11, 16)} ${x.title}`).join(', ')}.` : 'Nothing on your Apple Calendar in the next day.'; }
      throw new Error('unknown lookup');
    },
    questions: () => openQuestions().map((q) => ({ ref: `${q.project}/${q.missionId}/${q.subtaskId}`, who: crewName(q.who) || q.who || 'A teammate', project: q.project, what: askWhat(q.ask) || q.title, reply: q.ask?.reply || '' })),
    switchFolder: (q) => focus.open(q, 'ivy'),
    office: () => ({ current: focus.get().project, folders: focus.folderNames() }),
    answerQuestion: (ref, text) => { const [project, mission, ...sub] = String(ref).split('/'); return M.answer(project, mission, sub.join('/'), text); },
    file: async (text, proj) => { // Ivy decided the owner asked for work (or they said "add this to the list")
      const m = text.match(/^([\w.-]+)\s*:\s*([\s\S]+)$/);
      const names = listProjects();
      const [project, prompt] = proj && names.includes(proj) ? [proj, text] : m && names.includes(m[1]) ? [m[1], m[2]] : [focus.get().project || 'success-manager', text]; // no project named: where the office is working now
      M.create(project, `For ARES (Floor Manager): the owner asked IVY (the secretary, by phone or WhatsApp) to pass this on — ${prompt}`);
      return project;
    } }) });
  // IVY's desk: tasks, knowledge, missed-while-away checklist, callbacks, digest (bin/secretary.js). Live facts come from the engine.
  const secretary = require('./secretary.js').createSecretary(ROOT, {
    calls: (o) => phone.calls(o),
    missions: allMissions,
    questions: () => { try { return listProjects().flatMap((n) => (state(n).questions || [])); } catch { return []; } },
    sendText: (t) => notify(t),
    // a task the owner hands IVY becomes a mission for ARES (default: the office itself)
    handOff: (project, prompt) => { const m = M.create(project && listProjects().includes(project) ? project : 'success-manager', prompt); return { project: m.project, id: m.id }; },
  });
    // IVY's day: reminders that fire, the morning brief on WhatsApp, and the dev pulse kept fresh. Started by the office server.
  const ivyDay = (() => {
    let timer = null; let sending = false;
    const brief = () => {
      const g = ivyGoogle.current(); const d = devpulse.current();
      return secretary.morningBrief({ events: g.events || [], code: devpulse.attention(d).filter((a) => a.level <= 2).map((a) => a.text), yesterday: devpulse.yesterday(d) });
    };
    const prepare = () => Promise.all([devpulse.fresh().catch(() => null), ivyGoogle.refresh().catch(() => null)]);
    async function sendBrief() { await prepare(); const b = brief(); await notify(telegram.linked() ? b.text.replace(/\*(.+?)\*/g, '$1') : b.text); secretary.markBriefSent(); return { ok: true, sent: b.text }; }
    async function tick() {
      if (sending) return; sending = true;
      try {
        for (const r of secretary.dueReminders()) {
          try {
            if (r.via === 'call' && !phoneSet().off) await phone.call(`Hi, it's Ivy. Reminder: ${r.text}`); else await notify(`⏰ Reminder: ${r.text}`);
            secretary.markReminder(r.id, 'sent');
          } catch (e) { secretary.markReminder(r.id, 'failed'); try { errorlog.record({ source: 'ivy', title: `Reminder not sent: ${e.message}`, detail: r.text }); } catch { /* ignore */ } }
        }
        if (secretary.briefDue()) { try { await sendBrief(); } catch (e) { secretary.markBriefSent(); try { errorlog.record({ source: 'ivy', title: `Morning brief not sent: ${e.message}` }); } catch { /* ignore */ } } }
        try { const nudge = wellbeing.breakDue(); if (nudge) await notify(nudge); } catch { /* a missed nudge is fine */ }
        devpulse.current(); // background rescan when older than 15 minutes
      } finally { sending = false; }
    }
    // the phone line's public address: started, watched and re-pointed by the office (bin/tunnel.js)
    const tunnel = require('./tunnel.js').createTunnel(ROOT, { integrations, notify: (t) => notify(t).catch(() => {}), log: (m) => console.log(`[IVY] ${m}`) });
    // calls that never reached the office (line down): logged and sent to the owner, with the voicemail audio
    const missed = require('./missed-calls.js').createMissedCalls(ROOT, { integrations, isOff: () => !!phoneSet().off, callLog: { list: (o) => phone.calls(o), upsert: (r) => require('./call-log.js').createCallLog(ROOT).upsert(r) }, notify: (t) => notify(t), sendAudio: (b, o) => (telegram.linked() ? telegram.sendAudio(b, o) : notify(o.caption)), recognise: (n) => secretary.recognise(n) });
    let stopTelegram = null;
    return { brief, prepare, sendBrief, tick, tunnel, missed, start(everyMs = 30000) { if (!stopTelegram) { stopTelegram = ivyTelegram.start(); tunnel.start(); missed.start(); } if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, everyMs); timer.unref?.(); setTimeout(() => tick().catch(() => {}), 5000).unref?.(); } } };
  })();
  // IVY's Telegram gateway: mission reports and agents' questions go out, replies answer them, urgent ones ring the owner.
  const ivyTelegram = require('./ivy-telegram.js').createIvyTelegram(ROOT, {
    tg: telegram, missions: allMissions, questions: openQuestions, name: crewName,
    confirmDraft: (id, o) => phone.chat.confirmDraft(id, o),
    answer: (project, mission, subtask, text) => M.answer(project, mission, subtask, text),
    reply: (project, mission, text) => M.reply(project, mission, text),
    call: (text) => phone.call(text), phoneOff: () => !!phoneSet().off,
    chat: (text, extra) => phone.converse(text, extra),
    open: (q) => focus.open(q, 'ivy'), where: () => focus.get().project,
    folders: () => { const managed = listProjects(); return [...managed, ...focus.folderNames().filter((n) => !managed.includes(n) && n !== 'success-manager')]; },
    today: () => ivyDay.brief().text.replace(/\*(.+?)\*/g, '$1'),
    code: () => { const d = devpulse.current(); const a = devpulse.attention(d).filter((x) => x.level <= 2); return a.length ? a.map((x) => `${['🔴', '🟠', '🟡'][x.level]} ${x.text}`).join('\n') : 'All pushed, all green.'; },
    status: () => { const k = secretary.knowledge(); return [secretary.briefing(), ...k.activeMissions.slice(0, 6).map((m) => `• ${m.project}: ${m.prompt} (${m.status})`)].join('\n'); },
  });
  secretary.sendBrief = () => ivyDay.sendBrief(); // routes: POST /sm/secretary/sendBrief
  secretary.previewBrief = () => ivyDay.brief();
  const firebase = require('./firebase.js').createFirebase(ROOT);
  const onboarding = require('./onboarding.js').createOnboarding(ROOT);
  const setup = require('./setup-check.js').createSetupCheck(ROOT, { integrations }); // what this machine still needs (onboarding + sm doctor)
  const ideasApi = require('./ideas.js').createIdeas(ROOT);
  const meetingsApi = require('./meetings.js').createMeetings((name) => loadProject(name).dir);
  const ACTIVE = ['queued', 'planning', 'working', 'checking', 'paused', 'waiting_human', 'reviewing'];
  const auditing = new Map(); // project -> { pid, agents, startedAt }
  const auditAlive = (name) => {
    const a = auditing.get(name);
    if (!a) return null;
    try { process.kill(a.pid, 0); return a; } catch { auditing.delete(name); return null; }
  };

  const fixing = new Map(); // project -> { pid, id, startedAt } for the Fix button
  const fixAlive = (name) => {
    const f = fixing.get(name);
    if (!f) return null;
    try { process.kill(f.pid, 0); return f; } catch { fixing.delete(name); return null; }
  };

  function issues(p) {
    if (!usesBeads(p)) return [];
    let j;
    try { j = JSON.parse(bd(p, ['list', '--all', '--json', '--limit', '0']) || '[]'); }
    catch { return []; } // a broken/half-migrated beads db must not take the whole office panel down
    return (Array.isArray(j) ? j : j.issues || []).filter((i) => !(i.labels || []).includes('mission')).map((i) => ({
      id: i.id, title: i.title, status: i.status, priority: i.priority, labels: i.labels || [],
      description: i.description || '', notes: i.notes || '', closedAt: i.closed_at || null, reason: i.close_reason || '',
    }));
  }

  const asksFile = (p) => path.join(p.dir, 'asks.json');
  const readAsks = (p) => readJSON(asksFile(p), {});
  function setAsk(name, id, ask) {
    const p = loadProject(name);
    const all = readAsks(p);
    all[id] = { ...ask, updatedAt: new Date().toISOString() };
    fs.writeFileSync(asksFile(p), JSON.stringify(all, null, 2) + '\n');
    cache.delete(name);
  }

  // `bd` is ~1-2s per call (Dolt), so each refresh makes exactly one and caches it briefly.
  const SNAPSHOT_TTL_MS = 20000; // every write path calls cache.delete, so reads can stay stale a while
  const cache = new Map();
  function snapshot(name) {
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.value;
    const p = loadProject(name);
    const all = issues(p);
    const asks = readAsks(p);
    for (const i of all) if (isHumanTask(i)) i.ask = asks[i.id] || parseAskNotes(i.notes) || null;
    const open = all.filter((i) => i.status !== 'closed');
    const summary = {
      open: open.filter((i) => !isHumanTask(i) && !i.labels.includes('suggestion')).map((i) => i.id),
      human: open.filter(isHumanTask).map((i) => i.id),
      suggestions: open.filter((i) => i.labels.includes('suggestion') && !isHumanTask(i)).map((i) => i.id),
      done: all.filter((i) => i.status === 'closed').map((i) => i.id),
    };
    const value = { p, all, summary, status: overallStatus(p, p.state.lastResults || [], summary, p.state.lastVerdict) };
    cache.set(name, { at: Date.now(), value });
    return value;
  }

  function logLines(p, all) {
    const lines = [];
    const push = (ts, agent, level, msg) => lines.push({ ts, agent, level, msg });
    const hist = path.join(p.dir, 'history.log');
    if (fs.existsSync(hist)) {
      for (const l of fs.readFileSync(hist, 'utf8').trim().split('\n').slice(-300)) {
        const [ts, ...rest] = l.split(/\s{2}/);
        const msg = rest.join('  ');
        if (/^AUDIT/.test(msg)) push(ts, 'ORCHESTRATOR', 'INFO', `Reviewer sweep complete — ${msg.replace('AUDIT ', '')}`);
        else push(ts, 'QA', /FAIL|GAVE UP/.test(msg) ? 'ERROR' : /CONTINUE/.test(msg) ? 'WARN' : 'INFO', msg);
      }
    }
    const auditsDir = path.join(p.dir, 'audits');
    if (fs.existsSync(auditsDir)) {
      for (const f of fs.readdirSync(auditsDir).sort().slice(-5)) {
        const a = readJSON(path.join(auditsDir, f), null);
        if (!a) continue;
        for (const r of a.agents || []) push(a.at, `${r.agent.toUpperCase()} AGENT`, r.ok ? 'INFO' : 'ERROR', r.ok ? `Scan finished: ${r.found} finding(s) in ${r.seconds}s ($${(r.cost || 0).toFixed(2)})` : `Scan failed: ${r.error || 'unknown error'}`);
        for (const x of a.findings || []) push(a.at, `${x.agent.toUpperCase()} AGENT`, x.priority <= 1 ? 'ERROR' : x.priority === 2 ? 'WARN' : 'INFO', `Filed ${x.id} P${x.priority}${x.needs_human ? ' [human]' : x.suggestion ? ' [suggestion]' : ''}: ${x.title}`);
      }
    }
    const runs = path.join(p.dir, 'runs');
    if (fs.existsSync(runs)) {
      const latest = fs.readdirSync(runs).filter((f) => f.endsWith('.log')).map((f) => path.join(runs, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).pop();
      if (latest) {
        let lastTs = new Date(fs.statSync(latest).birthtimeMs).toISOString();
        for (const l of fs.readFileSync(latest, 'utf8').split('\n').slice(-200).filter((x) => x.trim())) {
          const m = l.match(/^\[(\d{4}-[^\]]+)\]\s*(.*)$/);
          if (m) { lastTs = m[1]; push(m[1], 'ORCHESTRATOR', /GAVE UP|error|fail/i.test(m[2]) ? 'WARN' : 'INFO', m[2]); }
          else push(lastTs, 'BUILDER', 'INFO', l); // the builder's own words between orchestrator lines
        }
      }
    }
    for (const i of all.filter((x) => x.status === 'closed' && x.closedAt)) push(i.closedAt, 'BUILDER', 'INFO', `Closed ${i.id}: ${i.title}${i.reason ? ` — ${i.reason}` : ''}`);
    const seen = new Set();
    return lines
      .filter((l) => { const k = `${l.ts}|${l.agent}|${l.msg}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
      .slice(-400);
  }

  function projects() {
    return listProjects().map((n) => {
      try { const s = snapshot(n); return { name: n, status: s.status, running: isRunning(s.p) }; }
      catch (e) { return { name: n, status: 'ERROR', error: e.message }; }
    });
  }

  const healthBoard = require('./health.js').createHealth(sm, {
    taskPriorities: (n) => { const p = loadProject(n); return usesBeads(p) ? snapshot(n).all.filter((i) => i.status !== 'closed').map((i) => i.priority) : null; },
  });

  // METER switches Claude accounts; the owner hears about switches, failures, dead logins and "all full" on Telegram.
  const accounts = require('./cswap-watch.js').createWatcher({ onEvent: (e) => {
    const t = e.kind === 'switched' ? `🔄 METER switched Claude to account #${e.to}${e.email ? ` (${e.email})` : ''}: #${e.from} hit its limit.`
      : e.kind === 'switch-failed' ? `⚠️ METER couldn't switch to Claude account #${e.to}${e.detail ? ` (${e.detail})` : ''}. Trying the next one.`
      : e.kind === 'relogin' ? `🔑 Claude account #${e.number}${e.email ? ` (${e.email})` : ''} needs a re-login, so METER can't use it. Log in as it with \`claude\` → /login, then run \`cswap add\`.`
      : e.kind === 'all-full' ? `⏸ Every Claude account is at its limit${e.until ? ` until ${new Date(e.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}. The office waits.` : '';
    if (t) notify(t).catch(() => {});
  } });
  const learning = require('./learning.js').createLearning(sm.ROOT);
  const errorlog = require('./errorlog.js').createErrorLog(sm, { missions: M, learning }); // TRACE: logs errors, ARES fixes after the owner approves
  const watch = require('./watchdog.js').createWatchdog(sm); // ARES's supervision: every few minutes + after each mission
  function state(name) {
    const { p, all, summary: t, status } = snapshot(name);
    const results = p.state.lastResults || [];
    const auditsDir = path.join(p.dir, 'audits');
    const audits = fs.existsSync(auditsDir) ? fs.readdirSync(auditsDir).sort().map((f) => readJSON(path.join(auditsDir, f), {})) : [];
    const running = isRunning(p);
    const audit = auditAlive(name);
    const lastAudit = p.state.lastAudit;
    const missions = M.snapshot(name); // before the crew map: the Planner's state reads it
    const roster = staffApi.load();
    const inProgress = all.find((i) => i.status === 'in_progress');
    const agents = roster.staff.map((st) => {
      const look = { name: st.name, title: st.title, room: st.room, kind: st.kind, agentId: st.agentId, palette: st.palette, hueShift: st.hueShift };
      if (st.kind === 'reviewer') {
        const mine = all.filter((i) => i.labels.includes(`src:audit-${st.id}`));
        const humanOpen = mine.filter((i) => i.status !== 'closed' && isHumanTask(i));
        const run = lastAudit?.agents?.find((r) => r.agent === st.id);
        const working = Boolean(audit && (!audit.agents || audit.agents.includes(st.id)));
        return {
          ...look, id: st.id,
          state: working ? 'WORKING' : humanOpen.length ? 'BLOCKED' : 'IDLE',
          task: working ? `Reviewing ${name}…` : humanOpen[0]?.title || (run ? `Last sweep: ${run.found} finding(s)` : 'Ready for a review'),
          blockedOn: humanOpen.map((i) => i.id),
          filed: mine.length, open: mine.filter((i) => i.status !== 'closed').length,
          lastCost: run?.cost || 0, lastSeconds: run?.seconds || 0, lastOk: run ? run.ok : null,
          findings: (lastAudit?.findings || []).filter((f) => f.agent === st.id),
        };
      }
      if (st.id === 'errorlog') {
        const errs = errorlog.list();
        const open = errs.filter((e) => e.status === 'open').length;
        return { ...look, id: st.id, blockedOn: [], open, filed: errs.length, state: open ? 'BLOCKED' : 'WORKING', task: open ? errorlog.summary() : 'Watching for errors — none open' };
      }
      if (st.kind === 'watcher') {
        const snap = accounts.snapshot();
        return { ...look, id: st.id, blockedOn: [], open: 0, filed: 0, state: snap.available ? 'WORKING' : 'IDLE', task: require('./cswap-watch.js').describe(snap) };
      }
      if (st.kind === 'engineer') {
        const lead = st.id === 'builder'; // `sm run` drives the lead engineer
        return {
          ...look, id: st.id, blockedOn: [], filed: 0,
          state: lead && running ? 'WORKING' : 'IDLE',
          task: lead && running ? (inProgress ? `${inProgress.id}: ${inProgress.title}` : 'Working the queue…')
            : lead && t.open.length ? `${t.open.length} task(s) queued — start me with sm run ${name}` : 'Ready for work',
          open: lead ? t.open.length : 0, closed: lead ? t.done.length : 0,
        };
      }
      if (st.kind === 'planner') {
        const drafting = missions.find((m) => m.status === 'planning' && !m.plan);
        return { ...look, id: st.id, blockedOn: [], open: 0, filed: 0, state: drafting ? 'WORKING' : 'IDLE', task: drafting ? 'Drafting a plan for ARES…' : 'Waiting for the next request' };
      }
      if (st.kind === 'ideas') {
        const ist = Object.values(ideasApi.statuses(name)).find((x) => x.running) || {};
        const n = ideasApi.list(name).length;
        return { ...look, id: st.id, blockedOn: [], open: 0, filed: 0, state: ist.running ? 'WORKING' : 'IDLE',
          task: ist.running ? `Coming up with fresh ideas for ${name}…` : n ? `${n} ideas ready — click 💡 Ideas` : 'Click 💡 Ideas → Fresh ideas' };
      }
      return { ...look, id: st.id, state: running || audit ? 'WORKING' : 'IDLE', task: `Status: ${status}`, blockedOn: [], open: 0, filed: 0 };
    });

    // Missions (Floor Manager) override what the crew is doing right now.
    const active = missions.filter((m) => ACTIVE.includes(m.status));
    const questions = [];
    for (const m of active) {
      if (m.access?.status === 'asking') {
        const boss0 = agents.find((x) => x.kind === 'manager');
        const q = { missionId: m.id, subtaskId: '__access', who: boss0?.id || 'orchestrator', title: 'Team access', ask: m.access.ask, prompt: m.prompt, kind: 'access' };
        questions.push(q);
        if (boss0) { boss0.state = 'BLOCKED'; boss0.task = m.access.ask.what; boss0.question = { missionId: m.id, subtaskId: '__access', title: 'Team access', ask: m.access.ask, kind: 'access' }; }
      }
      for (const st of m.subtasks || []) {
        const a = agents.find((x) => x.id === st.assignee);
        if (!a) continue;
        if (st.status === 'waiting_human') {
          a.state = 'BLOCKED'; a.task = st.question?.what || st.title;
          a.question = { missionId: m.id, subtaskId: st.id, title: st.title, ask: st.question };
          questions.push({ missionId: m.id, subtaskId: st.id, who: st.assignee, title: st.title, ask: st.question, prompt: m.prompt });
        } else if (['working', 'answered'].includes(st.status) && a.state !== 'BLOCKED') {
          // Replit-style: the label shows what they are doing right now, not just the job title.
          a.state = 'WORKING'; a.task = st.lastAction || `Mission: ${st.title}`;
        }
        if (['working', 'answered', 'waiting_human', 'done', 'failed'].includes(st.status)) {
          a.live = { missionId: m.id, subtaskId: st.id, title: st.title, status: st.status, lastAction: st.lastAction || null };
        }
      }
      const boss = agents.find((x) => x.kind === 'manager') || agents[0];
      if (boss.state === 'BLOCKED') continue;
      const asked = (m.subtasks || []).find((x) => x.status === 'triaging');
      if (asked) { boss.state = 'WORKING'; boss.task = `Answering ${agents.find((x) => x.id === asked.assignee)?.name || 'a teammate'}'s question`; continue; }
      if (['queued', 'planning', 'reviewing'].includes(m.status)) { boss.state = 'WORKING'; boss.task = m.status === 'reviewing' ? 'Reviewing the team\'s work' : `Planning: ${m.prompt.slice(0, 60)}`; }
      else if (boss.state !== 'WORKING') { boss.state = 'WORKING'; boss.task = `Running mission (${(m.subtasks || []).filter((x) => x.status === 'done').length}/${(m.subtasks || []).length} done)`; }
    }
    // ARES watches the office when nothing needs him: his status shows what his checks found
    const watched = watch.latest();
    const problems = (watched.findings || []).filter((f) => f.severity !== 'info');
    const bossW = agents.find((x) => x.kind === 'manager');
    if (bossW && bossW.state !== 'WORKING' && bossW.state !== 'BLOCKED' && problems.length) bossW.task = `Watching: ${problems.length} problem${problems.length > 1 ? 's' : ''} — see HEALTH`;
    const traceSays = errorlog.summary();
    if (bossW && traceSays && bossW.state !== 'WORKING') bossW.task = `${traceSays.replace('TRACE reports', 'TRACE told me about')}`;
    const events = missions.flatMap((m) => (m.events || []).map((e) => ({ ...e, missionId: m.id }))).sort((a, b) => a.ts.localeCompare(b.ts)).slice(-60);
    // a finished video is shown in a conference-room meeting, never on the desk
    const reports = missions.filter((m) => m.report && !m.meetingId).map((m) => ({ id: m.id, prompt: m.prompt, at: m.report.at, headline: m.report.headline, verdict: m.report.verdict,
      replies: (m.replies || []).length, replyPending: Boolean(m.replyPending), parentId: m.parentId || null, followUpId: m.followUpId || null }));

    return {
      project: name, path: p.config.path, status, active: p.config.active, fullAccess: p.config.fullAccess ?? null,
      qa: results.map((r) => ({ name: r.name, ok: r.ok, code: r.code, seconds: r.seconds, output: r.ok ? '' : r.output })),
      lastQaAt: p.state.lastRun || null,
      running, runStartedAt: running ? p.state.runStartedAt || null : null,
      auditing: audit ? { startedAt: audit.startedAt, agents: audit.agents } : null,
      fixing: fixAlive(name) ? { id: fixing.get(name).id, startedAt: fixing.get(name).startedAt } : null,
      cost: { total: audits.reduce((s, a) => s + (a.cost || 0), 0), last: lastAudit?.cost || 0, audits: audits.length, today: M.todayCost(name) },
      lastAuditAt: lastAudit?.at || null,
      agents,
      tasks: {
        critical: results.filter((r) => !r.ok).map((r) => ({ id: `qa:${r.name}`, title: `QA failing: ${r.name}`, priority: 0, labels: ['qa'], status: 'open', description: r.output })),
        required: all.filter((i) => i.status !== 'closed' && !isHumanTask(i) && !i.labels.includes('suggestion')),
        human: all.filter((i) => i.status !== 'closed' && isHumanTask(i)).sort((a, b) => a.priority - b.priority),
        suggestions: all.filter((i) => i.status !== 'closed' && i.labels.includes('suggestion') && !isHumanTask(i)),
        done: all.filter((i) => i.status === 'closed').sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, 30),
      },
      logs: logLines(p, all),
      missions: missions.map(({ events: _e, ...m }) => m),
      staff: roster,
      ideas: ideasApi.list(name),
      ideasStatus: ideasApi.statuses(name), // per tab
      ideaCategories: require('./ideas.js').CATEGORIES.map(({ id, label }) => ({ id, label })),
      questions,
      events,
      reports,
      meetings: meetingsApi.open(name),
    };
  }

  function diff(name) {
    const p = loadProject(name);
    const r = spawnSync('git', ['-C', p.config.path, 'log', '-1', '--stat', '-p', '--format=%h %s%n%an · %ar%n'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const out = r.stdout || r.stderr || '';
    const lines = out.split('\n');
    return lines.length > 600 ? `${lines.slice(0, 600).join('\n')}\n… (${lines.length - 600} more lines)` : out;
  }

  /** Throws { status, message } on bad input. */
  function audit(body) {
    const p = loadProject(body.project);
    cache.delete(p.name);
    if (auditAlive(p.name)) throw Object.assign(new Error('Reviewers are already on shift for this project.'), { status: 409 });
    const agents = Array.isArray(body.agents) && body.agents.length ? body.agents.filter((a) => AGENTS.includes(a)) : null;
    fs.mkdirSync(path.join(p.dir, 'runs'), { recursive: true });
    const fd = fs.openSync(path.join(p.dir, 'runs', `audit-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), 'a');
    const child = spawn(process.execPath, [SELF, 'audit', p.name, ...(agents ? ['--agents', agents.join(',')] : [])], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    auditing.set(p.name, { pid: child.pid, agents, startedAt: new Date().toISOString() });
    return { ok: true, agents: agents || AGENTS };
  }

  /** The Fix button: one builder run aimed at a single review-created task. Throws { status, message }. */
  function fix(body) {
    const p = loadProject(body.project);
    cache.delete(p.name);
    const id = String(body.id || '');
    if (!/^[\w.-]+$/.test(id)) throw Object.assign(new Error('bad task id'), { status: 400 });
    const task = issues(p).find((i) => i.id === id);
    if (!task) throw Object.assign(new Error(`No task ${id} in ${p.name}.`), { status: 404 });
    if (task.status === 'closed') throw Object.assign(new Error(`${id} is already done.`), { status: 409 });
    if (!isReviewTask(task)) throw Object.assign(new Error('Fix is only for tasks created by a review.'), { status: 400 });
    if (isHumanTask(task)) throw Object.assign(new Error('That task needs a person, not a worker.'), { status: 400 });
    // fixAlive covers the gap before the new `sm run` has registered its pid (double-click, two tabs)
    if (isRunning(p) || fixAlive(p.name)) throw Object.assign(new Error('A worker is already running in this project.'), { status: 409 });
    fs.mkdirSync(path.join(p.dir, 'runs'), { recursive: true });
    const fd = fs.openSync(path.join(p.dir, 'runs', `fix-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), 'a');
    const child = spawn(process.execPath, [SELF, 'run', p.name, '--task', id], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    fixing.set(p.name, { pid: child.pid, id, startedAt: new Date().toISOString() });
    return { ok: true, id };
  }

  function human(body) {
    const p = loadProject(body.project);
    cache.delete(p.name);
    const id = String(body.id || '');
    const text = String(body.text || '').trim();
    if (!/^[\w.-]+$/.test(id) || !text) throw Object.assign(new Error('id and text are required'), { status: 400 });
    bd(p, ['note', id, `[human input ${new Date().toISOString()}] ${text}`]);
    if (body.resolve) bd(p, ['close', id, '--reason', `Resolved by human: ${text.slice(0, 300)}`]);
    else if (body.handBack) { bd(p, ['label', 'remove', id, 'human']); bd(p, ['label', 'remove', id, 'escalated']); }
    return { ok: true };
  }

  const ideas = {
    list: (project) => ({ ideas: ideasApi.list(project), status: ideasApi.statuses(project) }),
    thoughts: (body) => ideasApi.addThoughts(body.project, String(body.id), body.text),
    dismiss: (body) => { ideasApi.dismiss(body.project, String(body.id)); return ideasApi.list(body.project); },
    /** "Fresh ideas": one short MUSE pass over the project (in the background). */
    fresh: (body) => { loadProject(body.project); return ideasApi.requestFresh(body.project, { self: SELF, cwd: ROOT, category: body.category }); },
    /** Give an idea to the Planner: it becomes a mission (Planner → Floor Manager approval → team). */
    givePlanner: (body) => {
      const idea = ideasApi.get(body.project, String(body.id)); // validates first
      const m = M.create(body.project, ideasApi.promptFor(idea));
      ideasApi.use(body.project, idea.id);
      return { mission: m, ideas: ideasApi.list(body.project) };
    },
  };
  const mission = {
    create: (body) => { const m = M.create(body.project, body.prompt); try { learning.learnFromPrompt(body.prompt); } catch { /* learning never blocks a request */ } return m; },
    answer: (body) => M.answer(body.project, body.mission, body.subtask, body.text),
    reply: (body) => M.reply(body.project, body.mission, body.text, { answerOnly: body.answerOnly === true }),
    /** Live activity of one job (what the agent read, ran, edited, thought) from line `since` on. */
    stream: (project, mission, subtask, since = 0) => {
      const p = loadProject(project);
      if (!/^m-[\w-]+$/.test(String(mission)) || !/^s\d+$/.test(String(subtask))) throw Object.assign(new Error('bad id'), { status: 400 });
      const f = path.join(p.dir, 'missions', `${mission}.${subtask}.stream.jsonl`);
      if (!fs.existsSync(f)) return { lines: [], next: 0 };
      const all = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      const from = Math.max(0, Math.min(Number(since) || 0, all.length));
      const lines = all.slice(from, from + 500).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return { lines, next: from + lines.length };
    },
    diff: (project, mission) => {
      const p = loadProject(project);
      if (!/^m-[\w-]+$/.test(String(mission))) throw Object.assign(new Error('bad mission id'), { status: 400 });
      const f = path.join(p.dir, 'missions', `${mission}.diff`);
      return { diff: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
    },
    cancel: (body) => M.cancel(body.project, body.mission),
    resume: (body) => M.resume(body.project, body.mission),
    reorder: (body) => M.reorder(body.project, body.order),
    sendNow: (body) => M.sendNow(body.project, body.mission),
  };
  // ── Folder picker: choose which project the office works on ──
  const os = require('os');
  const HOME = os.homedir();
  const defaultBase = path.dirname(ROOT); // the folder that holds success-manager (your Projects folder)
  const insideHome = (p) => { const r = path.resolve(p); return r === HOME || r.startsWith(HOME + path.sep); };
  function folders(base) {
    const dir = path.resolve(base || defaultBase);
    if (!insideHome(dir)) throw Object.assign(new Error('Pick a folder inside your home folder.'), { status: 400 });
    const managed = new Map(listProjects().map((n) => { try { return [fs.realpathSync(loadProject(n).config.path), n]; } catch { return [null, n]; } }));
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => {
        const full = path.join(dir, e.name);
        let real = full; try { real = fs.realpathSync(full); } catch { /* broken link */ }
        const has = (f) => fs.existsSync(path.join(full, f));
        return {
          name: e.name, path: full, managedAs: managed.get(real) || null,
          kind: has('package.json') ? 'node' : fs.readdirSync(full).some((x) => x.endsWith('.xcodeproj')) ? 'ios' : has('Cargo.toml') ? 'rust' : has('pyproject.toml') ? 'python' : has('go.mod') ? 'go' : has('.git') ? 'git' : 'folder',
        };
      })
      .sort((a, b) => Number(Boolean(b.managedAs)) - Number(Boolean(a.managedAs)) || a.name.localeCompare(b.name));
    return { base: dir, parent: insideHome(path.dirname(dir)) ? path.dirname(dir) : null, entries };
  }
  function addProject(body) {
    const target = path.resolve(String(body.path || '').replace(/^~(?=$|\/)/, HOME));
    if (!insideHome(target) || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw Object.assign(new Error('That folder does not exist (or is outside your home folder).'), { status: 400 });
    const real = fs.realpathSync(target);
    for (const n of listProjects()) { try { if (fs.realpathSync(loadProject(n).config.path) === real) return { name: n, existing: true }; } catch { /* ignore */ } }
    const r = spawnSync(process.execPath, [SELF, 'add', target, '--beads'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) throw Object.assign(new Error((r.stderr || r.stdout || 'sm add failed').trim().split('\n').pop()), { status: 400 });
    const name = (r.stdout.match(/Managing "([^"]+)"/) || [])[1];
    return { name, existing: false, output: r.stdout.trim() };
  }

  // The office's focus: which folder the team is working in today (home stays success-manager). The office UI
  // follows it and writes it when the owner picks a folder; IVY moves it when asked ("open atlas-app").
  const focusFile = path.join(ROOT, 'office', 'focus.json');
  const focus = {
    get: () => { let f = {}; try { f = JSON.parse(fs.readFileSync(focusFile, 'utf8')); } catch { /* none yet */ } const names = listProjects(); return { project: names.includes(f.project) ? f.project : null, at: f.at || null, by: f.by || null }; },
    set: (body) => {
      const name = String(body?.project || '');
      if (!listProjects().includes(name)) throw Object.assign(new Error(`No project called "${name}".`), { status: 404 });
      const f = { project: name, at: new Date().toISOString(), by: String(body?.by || 'owner').slice(0, 20) };
      fs.mkdirSync(path.dirname(focusFile), { recursive: true }); fs.writeFileSync(focusFile, JSON.stringify(f)); return f;
    },
    /** "atlas-app", "the real estate folder", "~/code/x": a managed project, else a folder in the projects folder (added
     *  to the office first), else a path inside home. Returns { project, added, path }. */
    open: (query, by = 'ivy') => {
      const q = String(query || '').trim().replace(/^["']|["']$/g, ''); if (!q) throw Object.assign(new Error('Which folder?'), { status: 400 });
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
      const want = norm(q.replace(/^(the|my)\s+/i, '').replace(/\s+(folder|project|directory|repo|app)$/i, ''));
      const names = listProjects();
      const hit = names.find((n) => norm(n) === want);
      if (hit) return { ...focus.set({ project: hit, by }), added: false, path: loadProject(hit).config.path };
      let target = null;
      if (/^[~/]/.test(q)) target = q.replace(/^~(?=$|\/)/, HOME);
      else {
        const es = folders(defaultBase).entries;
        const e = es.find((x) => norm(x.name) === want) || es.find((x) => want.length >= 3 && norm(x.name).includes(want)) || es.find((x) => want.length >= 3 && want.includes(norm(x.name)) && norm(x.name).length >= 3);
        if (e?.managedAs) return { ...focus.set({ project: e.managedAs, by }), added: false, path: e.path };
        if (e) target = e.path;
      }
      if (!target) throw Object.assign(new Error(`I couldn't find a folder called "${q}" in ${defaultBase}.`), { status: 404 });
      const r = addProject({ path: target });
      return { ...focus.set({ project: r.name, by }), added: !r.existing, path: target };
    },
    folderNames: () => { try { return folders(defaultBase).entries.map((e) => e.name); } catch { return []; } },
  };

  const staff = {
    list: () => staffApi.load(),
    saveRoom: (body) => staffApi.saveRoom(body),
    update: (body) => staffApi.update(body),
    hire: (body) => staffApi.hire(body),
    fire: (body) => staffApi.fire(body),
  };
  /** Team access for a project: true = full (no permission prompts), false = safe command list. */
  function setAccess(body) {
    const p = loadProject(body.project);
    p.config.fullAccess = body.grant === true;
    p.config.fullAccessAnsweredAt = new Date().toISOString();
    fs.writeFileSync(path.join(p.dir, 'config.json'), JSON.stringify(p.config, null, 2) + '\n');
    cache.delete(p.name);
    return { ok: true, fullAccess: p.config.fullAccess };
  }
  const standupApi = require('./standup.js').createStandup(sm);
  const standup = { latest: () => standupApi.latest() || standupApi.generate(), startDaily: (o) => standupApi.startDaily(o) };
  /** Is a mission changing the office itself right now (any project)? Open tabs hold their auto-reload until it is done. */
  function officeBusy() {
    for (const name of listProjects()) {
      try { if (M.snapshot(name).some((m) => m.officeMission && ACTIVE.includes(m.status))) return true; } catch { /* skip */ }
    }
    return false;
  }

  const meetings = {
    join: (b) => meetingsApi.join(String(b?.project || ''), String(b?.id || '')),
    end: (b) => {
      const project = String(b?.project || ''), id = String(b?.id || '');
      const m = meetingsApi.end(project, id);
      // held notes only start work now, as one list for ARES
      const held = meetingsApi.takeHeld(project, id);
      if (held.length) M.create(project, `For ARES (Floor Manager): Edits requested on "${m.title}"${m.video ? ` (${m.video})` : ''} — the owner's notes from the meeting:\n${held.map((n, i) => `${i + 1}. ${n.text}`).join('\n')}`);
      return { ...m, started: held.length };
    },
    comment: (b) => {
      const project = String(b?.project || ''), id = String(b?.id || '');
      const r = meetingsApi.addNote(project, id, { kind: b?.kind, text: b?.text });
      // a question is answered right away; a note waits until the meeting is ejected
      if (r.note.kind === 'question') M.create(project, `For ARES (Floor Manager): Question about "${r.meeting.title}"${r.meeting.video ? ` (${r.meeting.video})` : ''} — answer it, do not change anything: ${r.note.text}`);
      return r.meeting;
    },
    dropNote: (b) => meetingsApi.dropNote(String(b?.project || ''), String(b?.id || ''), String(b?.noteId || '')),
    reveal: (b) => meetingsApi.reveal(String(b?.project || ''), String(b?.id || '')),
    video: (project, id) => meetingsApi.video(String(project || ''), String(id || '')),
    pdf: (project, id) => meetingsApi.pdf(String(project || ''), String(id || '')),
  };
    const calendar = {
    events: (q = {}) => google.events({ from: q.from ? Date.parse(q.from) : Date.now() - 86400000, to: q.to ? Date.parse(q.to) : Date.now() + 14 * 86400000 }),
    meet: (b = {}) => google.createMeeting({ title: b.title, start: b.start, minutes: b.minutes, attendees: String(b.attendees || '').split(/[,\s;]+/).filter(Boolean), description: b.description, notify: true }),
    linked: () => ({ linked: google.linked() }),
  };
  return { calendar, google, AGENTS, voice, phone, secretary, devpulse, ivyDay, wellbeing, glance, toolbelt, telegram, ivyTelegram, focus, firebase, onboarding, setup, integrations, meetings, accounts, watch, errorlog, learning, standup, projects, officeBusy, health: healthBoard, state, diff, audit, fix, human, setAsk, mission, ideas, folders, addProject, staff, setAccess };
}

module.exports = { createApi, parseAskNotes, isReviewTask, AGENTS };
