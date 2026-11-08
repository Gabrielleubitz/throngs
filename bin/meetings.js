/**
 * Conference-room meetings. When a mission finishes a video, its result goes here instead of onto the
 * owner's desk: the conference room "calls" the owner, the crew sits down, ARES explains what was done and
 * the video plays. Stored per project in projects/<name>/meetings.json. Also used directly (`sm meeting`)
 * for any meeting the owner should be called into.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const PDF_EXT = /\.pdf$/i;
const MAX_KEEP = 50;

/** A finished video file on disk (absolute, known extension, non-empty), or null. */
function videoFile(p, base) {
  const s = String(p || '').trim();
  if (!s || !VIDEO_EXT.test(s)) return null;
  const abs = path.isAbsolute(s) ? s : base ? path.resolve(base, s) : null;
  if (!abs) return null;
  try { return fs.statSync(abs).isFile() && fs.statSync(abs).size > 0 ? abs : null; } catch { return null; }
}

/** A finished PDF on disk (absolute, .pdf, non-empty), or null. */
function pdfFile(p, base) {
  const s = String(p || '').trim();
  if (!s || !PDF_EXT.test(s)) return null;
  const abs = path.isAbsolute(s) ? s : base ? path.resolve(base, s) : null;
  if (!abs) return null;
  try { return fs.statSync(abs).isFile() && fs.statSync(abs).size > 0 ? abs : null; } catch { return null; }
}

/** PDFs the mission's jobs reported (their `pdf` field), de-duplicated, existing files only. */
function pdfsFromSubtasks(subtasks, base) {
  const out = [];
  for (const st of subtasks || []) {
    const v = pdfFile(st?.result?.pdf, base);
    if (v && !out.some((x) => x.path === v)) out.push({ path: v, by: st.assignee || null });
  }
  return out;
}

/** Videos the mission's jobs reported (their `video` field), de-duplicated, existing files only. */
function videosFromSubtasks(subtasks, base) {
  const out = [];
  for (const st of subtasks || []) {
    const v = videoFile(st?.result?.video, base);
    if (v && !out.some((x) => x.path === v)) out.push({ path: v, by: st.assignee || null });
  }
  return out;
}

function createMeetings(dirFor) {
  const fileOf = (project) => path.join(dirFor(project), 'meetings.json');
  const load = (project) => { try { return JSON.parse(fs.readFileSync(fileOf(project), 'utf8')); } catch { return []; } };
  function save(project, list) {
    const f = fileOf(project);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(list.slice(-MAX_KEEP), null, 2) + '\n');
    fs.renameSync(`${f}.tmp`, f);
  }
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

  /** Call the owner into the conference room. `video` must be an existing video file. */
  function call(project, { title, summary, points, video, pdf, missionId, by, host } = {}) {
    const t = String(title || '').trim().slice(0, 120);
    if (!t) throw bad('A meeting needs a title');
    const v = video ? videoFile(video) : null;
    if (video && !v) throw bad(`No video file at ${video}`);
    const pd = pdf ? pdfFile(pdf) : null;
    if (pdf && !pd) throw bad(`No PDF file at ${pdf}`);
    const list = load(project);
    if (missionId && list.some((m) => m.missionId === missionId)) return list.find((m) => m.missionId === missionId);
    const m = {
      id: `mt-${Date.now().toString(36)}`, status: 'calling', at: new Date().toISOString(),
      title: t, summary: String(summary || '').trim().slice(0, 2000),
      points: (Array.isArray(points) ? points : []).map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 8),
      video: v, pdf: pd, missionId: missionId || null, by: by || null, host: host || 'orchestrator',
    };
    list.push(m);
    save(project, list);
    return m;
  }
  function setStatus(project, id, status) {
    const list = load(project);
    const m = list.find((x) => x.id === id);
    if (!m) throw bad('No such meeting', 404);
    if (m.status === 'ended') return m;
    m.status = status;
    m[status === 'ended' ? 'endedAt' : 'joinedAt'] = new Date().toISOString();
    save(project, list);
    return m;
  }
  const join = (project, id) => setStatus(project, id, 'in-meeting');
  const end = (project, id) => setStatus(project, id, 'ended');
  /** Meetings still waiting for the owner or in progress. */
  const open = (project) => load(project).filter((m) => m.status !== 'ended');
  /** The recorded video of a meeting (never a client-supplied path). */
  function video(project, id) {
    const m = load(project).find((x) => x.id === id);
    if (!m?.video) throw bad('This meeting has no video', 404);
    const f = videoFile(m.video);
    if (!f) throw bad('The video file is gone', 404);
    return { file: f, type: VIDEO_TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', size: fs.statSync(f).size };
  }
  /** The recorded PDF of a meeting (never a client-supplied path). */
  function pdf(project, id) {
    const m = load(project).find((x) => x.id === id);
    if (!m?.pdf) throw bad('This meeting has no PDF', 404);
    const f = pdfFile(m.pdf);
    if (!f) throw bad('The PDF file is gone', 404);
    return { file: f, type: 'application/pdf', size: fs.statSync(f).size };
  }
  /** Owner's comment on a meeting. kind 'note' is held (nothing runs) until the meeting ends; 'question' is for answering at once. */
  function addNote(project, id, { kind, text } = {}) {
    const t = String(text || '').trim().slice(0, 2000);
    if (!t) throw bad('Write something first');
    if (kind !== 'note' && kind !== 'question') throw bad('kind must be note or question');
    const list = load(project);
    const m = list.find((x) => x.id === id);
    if (!m) throw bad('No such meeting', 404);
    if (m.status === 'ended') throw bad('This meeting is over', 409);
    const n = { id: `n-${Date.now().toString(36)}${(m.notes || []).length}`, kind, text: t, at: new Date().toISOString(), sent: kind === 'question' };
    m.notes = [...(m.notes || []), n].slice(-100);
    save(project, list);
    return { meeting: m, note: n };
  }
  /** Remove a held note before the meeting ends. */
  function dropNote(project, id, noteId) {
    const list = load(project);
    const m = list.find((x) => x.id === id);
    if (!m) throw bad('No such meeting', 404);
    m.notes = (m.notes || []).filter((n) => n.id !== noteId || n.sent);
    save(project, list);
    return m;
  }
  /** Held notes of a meeting, marked sent so they are handed out once (call after the meeting ended). */
  function takeHeld(project, id) {
    const list = load(project);
    const m = list.find((x) => x.id === id);
    const held = (m?.notes || []).filter((n) => n.kind === 'note' && !n.sent);
    if (!held.length) return [];
    for (const n of held) n.sent = true;
    save(project, list);
    return held;
  }
  /** Show the meeting's video in Finder (macOS) so the owner can find the file. */
  function reveal(project, id) {
    const m = load(project).find((x) => x.id === id);
    const v = m?.pdf && !m.video ? pdf(project, id) : video(project, id);
    if (process.platform !== 'darwin') return { path: v.file, opened: false };
    execFile('open', ['-R', v.file], () => undefined);
    return { path: v.file, opened: true };
  }
  return { call, join, end, open, list: load, video, pdf, addNote, dropNote, takeHeld, reveal };
}

module.exports = { createMeetings, videosFromSubtasks, videoFile, pdfsFromSubtasks, pdfFile };
