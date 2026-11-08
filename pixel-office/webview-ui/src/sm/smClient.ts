/** HTTP client for the server's /sm/* bridge (server/src/sm/smRoutes.ts). Same token as hooks. */
import { serverToken } from '../transport/serverToken.js';
import type { RoomRecord, StaffRecord } from './crew.js';

/** One thing a new machine needs (bin/setup-check.js). */
export interface SmSetupItem { group: 'required' | 'recommended' | 'optional'; id: string; label: string; ok: boolean; fix: string; cmd?: string; link?: string; unlocks?: string; action?: 'create-env' }
export interface SmSetup { items: SmSetupItem[]; ready: boolean; required: { done: number; total: number } }

export interface SmAsk {
  what: string;
  why?: string;
  steps?: string[];
  doneWhen?: string;
  reply?: string;
}
export interface SmTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  labels: string[];
  description: string;
  notes?: string;
  reason?: string;
  closedAt?: string | null;
  ask?: SmAsk | null;
}
export interface SmAgent {
  id: string;
  state: 'WORKING' | 'IDLE' | 'BLOCKED';
  task: string;
  blockedOn?: string[];
  filed?: number;
  open?: number;
  closed?: number;
  lastCost?: number;
  lastSeconds?: number;
  findings?: Array<{ id: string; priority: number; title: string; file: string; evidence: string }>;
  question?: { missionId: string; subtaskId: string; title: string; ask?: SmAsk | null };
  /** The mission job they are on (for the live monitor). */
  live?: { missionId: string; subtaskId: string; title: string; status: string; lastAction: string | null };
}
export interface SmStreamLine {
  ts: string;
  kind: 'think' | 'say' | 'tool' | 'run' | 'done' | 'error' | 'finish';
  text: string;
}
export interface SmQuestion {
  missionId: string;
  subtaskId: string;
  who: string;
  title: string;
  prompt: string;
  ask?: SmAsk | null;
}
export interface SmSubtask {
  id: string;
  n: number;
  title: string;
  assignee: string;
  instructions: string;
  dependsOn: string[];
  status: 'queued' | 'working' | 'waiting_human' | 'answered' | 'triaging' | 'done' | 'failed' | 'skipped' | 'cancelled';
  /** gate = a QA/security hand-off check; rework = work sent back to be fixed. */
  kind?: 'gate' | 'rework';
  stage?: 'qa' | 'security';
  gate?: { pass: boolean; issues: Array<{ title: string; detail: string; file: string; fix_by: string }>; notes: string[]; checked: string };
  retries?: number;
  question?: SmAsk;
  answers?: Array<{ ts: string; text: string; by?: string }>;
  result?: { summary: string; details: string; files_changed: string[]; verified_by: string };
  error?: string;
  cost: number;
}
export interface SmReport {
  headline: string;
  verdict: 'success' | 'partial' | 'failed';
  summary: string;
  completed: Array<{ job: string; by: string; result: string }>;
  changes: Array<{ file: string; what: string }>;
  checks: { qa_passed: boolean; notes: string };
  concerns: string[];
  next_steps: string[];
  for_you: string;
  qa?: Array<{ name: string; ok: boolean; seconds: number }>;
  commits?: string[];
  diffStat?: string;
  changedFiles?: string[];
  hasDiff?: boolean;
  office?: boolean;
  cost?: number;
  at: string;
}
/** One message in a report's reply thread (bin/missions.js reply/answerReply). */
export interface SmReply {
  id: string;
  from: 'owner' | 'orchestrator';
  text: string;
  at: string;
  inReplyTo?: string;
  answerOnly?: boolean;
  error?: boolean;
  /** Set on ARES's answer when the reply started a follow-up mission. */
  followUpId?: string;
}
export interface SmMission {
  id: string;
  prompt: string;
  status: 'queued' | 'planning' | 'working' | 'checking' | 'paused' | 'waiting_human' | 'reviewing' | 'done' | 'failed' | 'cancelled' | 'stalled';
  /** Set while the mission waits out the owner's usage limit (ISO time it carries on). */
  limitUntil?: string | null;
  /** How the router handled it: answer / quick / solo / team, and which model. */
  route?: { funnel: 'answer' | 'quick' | 'solo' | 'team'; model: 'haiku' | 'sonnet' | 'opus'; reason: string };
  /** The hand-off loop: build → QA → security, with fix rounds. */
  loop?: { round: number; stage: string; history: Array<{ round: number; by: string; issues: string[] }> };
  createdAt: string;
  finishedAt?: string;
  plan?: { summary: string; bubble: string };
  /** The Planner's rewritten brief + draft steps, and the Floor Manager's approval of them. */
  planner?: { name: string; rewrittenPrompt: string; steps: string[]; risks: string };
  approval?: { status: 'approved' | 'amended'; note: string };
  subtasks: SmSubtask[];
  report?: SmReport;
  error?: string;
  cost: number;
  replies?: SmReply[];
  /** The owner's last reply is still being answered. */
  replyPending?: boolean;
  /** This mission was started from a reply to that mission's report. */
  parentId?: string;
  /** Latest follow-up mission started from a reply to this report. */
  followUpId?: string;
  /** Waiting its turn: place in the queue (1 = runs next). */
  queuePos?: number;
  /** Paused by "Send now" on another mission; carries on after it. */
  preempting?: { id: string; prompt: string } | null;
}
export interface SmEvent {
  ts: string;
  who: string;
  kind: 'say' | 'plan' | 'assign' | 'help' | 'done' | 'report' | 'celebrate' | 'reply';
  text: string;
  missionId: string;
}
export interface SmLog {
  ts: string | null;
  agent: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
}
export interface SmIdea {
  id: string;
  title: string;
  detail: string;
  thoughts: Array<{ text: string; at: string }>;
  revisited?: boolean;
  /** Which department tab it belongs to (features, design, security, quality, growth). */
  category?: string;
}
export interface SmWatchFinding { id: string; severity: 'critical' | 'warn' | 'info'; title: string; detail: string; fix?: string }
export interface SmWatch { at: string | null; fixed?: boolean; findings: SmWatchFinding[] }
export interface SmError { id: string; source: string; project: string; title: string; detail: string; status: 'open' | 'approved' | 'fixed' | 'dismissed'; count: number; first: string; last: string; missionId: string | null }
export interface SmLesson { id: string; text: string; kind: 'prompt' | 'error' | 'info'; source: string; at: string }
export interface SmIdeasStatus { running: boolean; startedAt?: string; error?: string; at?: string }
export interface SmState {
  project: string;
  /** Team access: true = full (no permission prompts), false = safe commands, null = not asked yet. */
  fullAccess: boolean | null;
  status: 'IN_PROGRESS' | 'AWAITING_HUMAN_INPUT' | 'PRODUCTION_READY' | string;
  qa: Array<{ name: string; ok: boolean; code: number | string; seconds: number; output?: string }>;
  running: boolean;
  runStartedAt: string | null;
  auditing: { startedAt: string; agents: string[] | null } | null;
  /** The review task a Fix-button worker is on right now. */
  fixing: { id: string; startedAt: string } | null;
  cost: { total: number; last: number; audits: number; today: number };
  agents: SmAgent[];
  tasks: { critical: SmTask[]; required: SmTask[]; human: SmTask[]; suggestions: SmTask[]; done: SmTask[] };
  logs: SmLog[];
  missions: SmMission[];
  staff: { rooms: RoomRecord[]; staff: StaffRecord[] };
  ideas: SmIdea[];
  /** Fresh-ideas status per tab. */
  ideasStatus?: Record<string, SmIdeasStatus>;
  ideaCategories?: Array<{ id: string; label: string }>;
  questions: SmQuestion[];
  events: SmEvent[];
  reports: Array<{
    id: string;
    prompt: string;
    at: string;
    headline: string;
    verdict: SmReport['verdict'];
    replies: number;
    replyPending: boolean;
    parentId: string | null;
    followUpId: string | null;
  }>;
  /** Conference-room meetings waiting for the owner (calling) or running (in-meeting). */
  meetings?: SmMeeting[];
}
export interface SmMeeting {
  id: string;
  status: 'calling' | 'in-meeting' | 'ended';
  at: string;
  title: string;
  summary: string;
  points: string[];
  /** Absolute path of the video on the server; fetched through /sm/meeting/video. */
  video: string | null;
  /** Absolute path of the PDF on the server; fetched through /sm/meeting/pdf. */
  pdf?: string | null;
  missionId: string | null;
  /** Crew id of whoever made the video. */
  by: string | null;
  /** Crew id running the meeting (the Floor Manager). */
  host: string;
  /** Owner's comments: notes are held until the meeting is ended, questions are sent at once. */
  notes?: SmMeetingNote[];
}
export interface SmMeetingNote { id: string; kind: 'note' | 'question'; text: string; at: string; sent: boolean }
export interface SmFolder {
  name: string;
  path: string;
  managedAs: string | null;
  kind: string;
}
export interface SmProject {
  name: string;
  status: string;
  running?: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(serverToken ? { Authorization: `Bearer ${serverToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string; fixUrl?: string };
  if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), body.fixUrl ? { fixUrl: body.fixUrl } : {});
  return body;
}

/** POST that returns audio instead of JSON. */
async function callBlob(path: string, body: unknown): Promise<Blob> {
  const r = await fetch(path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(serverToken ? { Authorization: `Bearer ${serverToken}` } : {}) },
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${r.status}`);
  return r.blob();
}

export interface SmIntegration {
  id: string; animal: number; name: string; service: string; does: string; docs: string; linked: boolean;
  oauth: { ready: boolean; signedIn: boolean; viaFirebase?: boolean } | null;
  fields: { key: string; label: string; secret: boolean; set: boolean; value: string }[];
}

export interface SmSecItem { id: string; kind: string; title: string; detail: string; at: string | null; done: boolean; number?: string }
export interface SmSecCall { id: string; callSid?: string; direction: 'in' | 'out'; from?: string; callerName?: string; isOwner?: boolean; outcome: string; summary?: string; requests?: string[]; messages?: string[]; turns?: number; durationSec?: number; endedAt?: string; at: string }
export interface SmReminder { id: string; text: string; at: string; via: 'whatsapp' | 'call'; status: string }
/** Day glance (bin/toolbelt.js via the jarvis daemon). */
export interface SmGlance { weather: string | null; linked: boolean; mail: { from: string; subject: string }[] | null; packages: number | null; flights: number | null }
/** Keep-awake + break nudges (bin/wellbeing.js). */
export interface SmWellbeing { awake: { on: boolean; until?: number | null }; breaks: { breaksOn: boolean; everyMin: number; from: number; to: number } }

/** The owner's dev pulse (bin/devpulse.js): local repos + GitHub, ranked. level 0 = urgent … 3 = dormant. */
export interface SmPulse {
  at: string;
  repos: { name: string; branch: string; dirty: number; ahead: number; behind: number; last: { at: string; subject: string } | null; today: string[] }[];
  github: { login?: string; error?: string; repos?: { slug: string; ci: string | null; pushedAt: string; prs: number; issues: number; alerts: number }[] };
  attention: { level: number; text: string; repo: string }[];
}
export interface SmCalEvent { id: string; calendar: string; color: string; primary: boolean; title: string; start: string; end: string; allDay: boolean; location: string; meet: string; attendees: { email: string; name: string; status: string }[]; link: string }
export interface SmSecretary {
  tasks: { id: string; title: string; detail: string; due: string; status: 'open' | 'done'; createdAt: string; mission?: { project: string; id: string }; missionStatus?: string | null }[];
  checklist: SmSecItem[]; callbacks: SmSecItem[]; calls: SmSecCall[]; briefing: string; digestAt: string | null;
  reminders?: SmReminder[]; brief?: { briefTime: string; briefOn: boolean; briefDate: string | null };
  knowledge: { schedule: { id: string; text: string }[]; facts: { id: string; text: string }[]; contacts: { id: string; name: string; number: string; note: string }[];
    tasks: unknown[]; activeMissions: { id: string; project: string; prompt: string; status: string }[]; waitingOnOwner: { missionId: string; title: string; ask: string }[] };
}

export interface SmHealth {
  name: string;
  lastQa: 'pass' | 'fail' | 'unknown';
  qaFailing: string[];
  /** Open tasks by priority, index 0-4. */
  openTasks: number[];
  openTotal: number;
  lastRun: string | null;
  verdict: string | null;
  gaveUp: boolean;
  rank: number;
}

export interface SmAccountWindow { pct: number; resetsAt: string | null; countdown: string | null }
export interface SmAccount { number: number; email: string; active: boolean; disabled: boolean; fiveHour: SmAccountWindow; sevenDay: SmAccountWindow }
export interface SmAccounts {
  available: boolean;
  at: string | null;
  active: SmAccount | null;
  accounts: SmAccount[];
  lastSwitch: { at: string; from?: number; to: number } | null;
  waitingUntil: string | null;
}

async function meetingBlob(kind: 'video' | 'pdf', project: string, id: string): Promise<string> {
  const r = await fetch(`/sm/meeting/${kind}?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`,
    { headers: serverToken ? { Authorization: `Bearer ${serverToken}` } : {} });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${r.status}`);
  return URL.createObjectURL(await r.blob());
}

export const smClient = {
  accounts: () => call<SmAccounts>('/sm/accounts'),
  refreshAccounts: () => call<SmAccounts>('/sm/accounts/refresh', { method: 'POST' }),
  enabled: () => call<{ ok: boolean }>('/sm/enabled').then((r) => r.ok).catch(() => false),
  projects: () => call<SmProject[]>('/sm/projects'),
  secretary: {
    state: () => call<SmSecretary>('/sm/secretary'),
    act: (name: string, body: Record<string, unknown> = {}) => call<unknown>(`/sm/secretary/${name}`, { method: 'POST', body: JSON.stringify(body) }),
  },
  glance: () => call<SmGlance>('/sm/glance'),
  wellbeing: {
    state: () => call<SmWellbeing>('/sm/wellbeing'),
    awake: (on: boolean, hours?: number) => call<SmWellbeing>('/sm/wellbeing/awake', { method: 'POST', body: JSON.stringify({ on, hours }) }),
    breaks: (b: { on?: boolean; everyMin?: number }) => call<SmWellbeing>('/sm/wellbeing/breaks', { method: 'POST', body: JSON.stringify(b) }),
  },
  focus: () => call<{ project: string | null; at: string | null; by: string | null }>('/sm/focus'),
  setFocus: (project: string) => call<unknown>('/sm/focus', { method: 'POST', body: JSON.stringify({ project }) }),
  calendar: (from: string, to: string) => call<SmCalEvent[]>(`/sm/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  newMeeting: (b: { title: string; start: string; minutes: number; attendees: string; description?: string }) => call<{ meet: string; link: string }>('/sm/calendar/meet', { method: 'POST', body: JSON.stringify(b) }),
  pulse: (refresh = false) => call<SmPulse>('/sm/pulse', refresh ? { method: 'POST', body: '{}' } : undefined),
  health: () => call<SmHealth[]>('/sm/health'),
  /** busy = an office mission is still running (its engineers rebuild to test; wait for the finished version). */
  build: () => call<{ id: string; busy?: boolean }>('/sm/build'),
  integrations: {
    list: () => call<SmIntegration[]>('/sm/integrations'),
    save: (id: string, values: Record<string, string>) => call<{ ok: boolean; linked: boolean }>('/sm/integrations/save', { method: 'POST', body: JSON.stringify({ id, values }) }),
    oauthStart: (id: string) => call<{ url: string; redirect: string }>('/sm/integrations/oauth/start', { method: 'POST', body: JSON.stringify({ id }) }),
    clear: (id: string) => call<{ ok: boolean }>('/sm/integrations/clear', { method: 'POST', body: JSON.stringify({ id }) }),
  },
  voice: () => call<{ enabled: boolean }>('/sm/voice'),
  setup: {
    check: () => call<SmSetup>('/sm/setup'),
    createEnv: () => call<SmSetup & { file: string }>('/sm/setup/env', { method: 'POST', body: '{}' }),
  },
  onboarding: {
    status: () => call<{ done: boolean; doneAt: string | null; hasVideo: boolean }>('/sm/onboarding'),
    complete: () => call<{ done: boolean }>('/sm/onboarding/complete', { method: 'POST', body: '{}' }),
    reset: () => call<{ done: boolean }>('/sm/onboarding/reset', { method: 'POST', body: '{}' }),
    /** The intro video as a blob URL (token rides a header). Revoke it when done. */
    video: async (): Promise<string> => {
      const r = await fetch('/sm/onboarding/video', { headers: serverToken ? { Authorization: `Bearer ${serverToken}` } : {} });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return URL.createObjectURL(await r.blob());
    },
  },
  firebase: {
    status: () => call<{ linked: boolean; projectId: string | null; clientEmail: string | null }>('/sm/firebase'),
    link: (key: string) => call<{ linked: boolean; projectId: string | null }>('/sm/firebase/link', { method: 'POST', body: JSON.stringify({ key }) }),
    unlink: () => call<{ linked: boolean }>('/sm/firebase/unlink', { method: 'POST', body: '{}' }),
    push: (passphrase: string) => call<{ ok: boolean; projectId: string }>('/sm/firebase/push', { method: 'POST', body: JSON.stringify({ passphrase }) }),
    pull: (passphrase: string) => call<{ ok: boolean; projectId: string }>('/sm/firebase/pull', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  },
  speak: (text: string) => callBlob('/sm/voice/speak', { text }),
  /** ARES's watch: what his health checks found (and fixed). */
  watch: () => call<SmWatch>('/sm/watch'),
  errors: () => call<SmError[]>('/sm/errors'),
  /** Report an error from the UI to TRACE. */
  reportError: (title: string, detail = '') => call<SmError>('/sm/errors', { method: 'POST', body: JSON.stringify({ title, detail }) }),
  approveError: (id: string) => call<SmError>('/sm/errors/approve', { method: 'POST', body: JSON.stringify({ id }) }),
  dismissError: (id: string) => call<SmError>('/sm/errors/dismiss', { method: 'POST', body: JSON.stringify({ id }) }),
  learnings: () => call<SmLesson[]>('/sm/learnings'),
  addLearning: (text: string, kind: SmLesson['kind'] = 'info') => call<SmLesson>('/sm/learnings', { method: 'POST', body: JSON.stringify({ text, kind }) }),
  removeLearning: (id: string) => call<{ ok: boolean }>('/sm/learnings/remove', { method: 'POST', body: JSON.stringify({ id }) }),
  watchNow: () => call<SmWatch>('/sm/watch/run', { method: 'POST', body: '{}' }),
  state: (project: string) => call<SmState>(`/sm/state?project=${encodeURIComponent(project)}`),
  diff: (project: string) => call<{ diff: string }>(`/sm/diff?project=${encodeURIComponent(project)}`),
  audit: (project: string, agents?: string[]) =>
    call<{ ok: boolean; agents: string[] }>('/sm/audit', { method: 'POST', body: JSON.stringify({ project, agents }) }),
  fix: (project: string, id: string) =>
    call<{ ok: boolean; id: string }>('/sm/fix', { method: 'POST', body: JSON.stringify({ project, id }) }),
  staff: {
    saveRoom: (roomId: string, prompt: string) => call<RoomRecord>('/sm/staff/room', { method: 'POST', body: JSON.stringify({ roomId, prompt }) }),
    update: (patch: Partial<StaffRecord> & { id: string }) => call<StaffRecord>('/sm/staff/update', { method: 'POST', body: JSON.stringify(patch) }),
    hire: (h: { name: string; title: string; kind: 'engineer' | 'reviewer'; room: string; brief: string; palette: number; hueShift: number }) =>
      call<StaffRecord>('/sm/staff/hire', { method: 'POST', body: JSON.stringify(h) }),
    fire: (id: string) => call<{ ok: boolean }>('/sm/staff/fire', { method: 'POST', body: JSON.stringify({ id }) }),
  },
  ideas: {
    addThoughts: (project: string, id: string, text: string) => call<SmIdea>('/sm/ideas/thoughts', { method: 'POST', body: JSON.stringify({ project, id, text }) }),
    dismiss: (project: string, id: string) => call<SmIdea[]>('/sm/ideas/dismiss', { method: 'POST', body: JSON.stringify({ project, id }) }),
    fresh: (project: string, category: string) => call<{ ok: boolean; already?: boolean }>('/sm/ideas/fresh', { method: 'POST', body: JSON.stringify({ project, category }) }),
    givePlanner: (project: string, id: string) => call<{ mission: SmMission; ideas: SmIdea[] }>('/sm/ideas/give-planner', { method: 'POST', body: JSON.stringify({ project, id }) }),
  },
  upload: (type: string, data: string) =>
    call<{ path: string; name: string; type: string; size: number }>('/sm/upload', { method: 'POST', body: JSON.stringify({ type, data }) }),
  folders: (base?: string) =>
    call<{ base: string; parent: string | null; entries: SmFolder[] }>(`/sm/folders${base ? `?base=${encodeURIComponent(base)}` : ''}`),
  setAccess: (project: string, grant: boolean) =>
    call<{ ok: boolean; fullAccess: boolean }>('/sm/project/access', { method: 'POST', body: JSON.stringify({ project, grant }) }),
  addProject: (path: string) =>
    call<{ name: string; existing: boolean }>('/sm/project/add', { method: 'POST', body: JSON.stringify({ path }) }),
  mission: {
    create: (project: string, prompt: string) =>
      call<SmMission>('/sm/mission/create', { method: 'POST', body: JSON.stringify({ project, prompt }) }),
    answer: (project: string, mission: string, subtask: string, text: string) =>
      call<{ ok: boolean }>('/sm/mission/answer', { method: 'POST', body: JSON.stringify({ project, mission, subtask, text }) }),
    stream: (project: string, mission: string, subtask: string, since: number) =>
      call<{ lines: SmStreamLine[]; next: number }>(`/sm/mission/stream?project=${encodeURIComponent(project)}&mission=${encodeURIComponent(mission)}&subtask=${encodeURIComponent(subtask)}&since=${since}`),
    diff: (project: string, mission: string) =>
      call<{ diff: string }>(`/sm/mission/diff?project=${encodeURIComponent(project)}&mission=${encodeURIComponent(mission)}`),
    reply: (project: string, mission: string, text: string, answerOnly = false) =>
      call<{ ok: boolean; reply: SmReply }>('/sm/mission/reply', { method: 'POST', body: JSON.stringify({ project, mission, text, answerOnly }) }),
    cancel: (project: string, mission: string) =>
      call<{ ok: boolean }>('/sm/mission/cancel', { method: 'POST', body: JSON.stringify({ project, mission }) }),
    resume: (project: string, mission: string) =>
      call<{ ok: boolean }>('/sm/mission/resume', { method: 'POST', body: JSON.stringify({ project, mission }) }),
    reorder: (project: string, order: string[]) =>
      call<{ ok: boolean; order: string[] }>('/sm/mission/reorder', { method: 'POST', body: JSON.stringify({ project, order }) }),
    sendNow: (project: string, mission: string) =>
      call<{ ok: boolean; paused: string[] }>('/sm/mission/send-now', { method: 'POST', body: JSON.stringify({ project, mission }) }),
  },
  meeting: {
    join: (project: string, id: string) => call<SmMeeting>('/sm/meeting/join', { method: 'POST', body: JSON.stringify({ project, id }) }),
    end: (project: string, id: string) => call<SmMeeting & { started?: number }>('/sm/meeting/end', { method: 'POST', body: JSON.stringify({ project, id }) }),
    comment: (project: string, id: string, kind: 'note' | 'question', text: string) => call<SmMeeting>('/sm/meeting/comment', { method: 'POST', body: JSON.stringify({ project, id, kind, text }) }),
    dropNote: (project: string, id: string, noteId: string) => call<SmMeeting>('/sm/meeting/note/drop', { method: 'POST', body: JSON.stringify({ project, id, noteId }) }),
    reveal: (project: string, id: string) => call<{ path: string; opened: boolean }>('/sm/meeting/reveal', { method: 'POST', body: JSON.stringify({ project, id }) }),
    /** The meeting's video / PDF as a blob URL (the token rides a header, which a bare <video src> can't send). Revoke it when done. */
    video: (project: string, id: string) => meetingBlob('video', project, id),
    pdf: (project: string, id: string) => meetingBlob('pdf', project, id),
  },
  human: (project: string, id: string, text: string, mode: 'note' | 'resolve' | 'handBack') =>
    call<{ ok: boolean }>('/sm/human', {
      method: 'POST',
      body: JSON.stringify({ project, id, text, resolve: mode === 'resolve', handBack: mode === 'handBack' }),
    }),
};

/** UI errors go to TRACE (the office's error-log bot). Capped and de-duplicated so a failing report can never report itself in a loop. */
let uiReports = 0;
const uiSeen = new Set<string>();
function reportUiError(title: string, detail = ''): void {
  const key = title.slice(0, 200);
  if (uiReports >= 5 || uiSeen.has(key)) return;
  uiSeen.add(key);
  uiReports += 1;
  void smClient.reportError(`UI error: ${key}`, detail).catch(() => { /* the log itself is down: stay silent */ });
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => reportUiError(e.message || 'Script error', e.error instanceof Error ? (e.error.stack ?? '') : `${e.filename ?? ''}:${e.lineno ?? ''}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    reportUiError(r instanceof Error ? r.message : String(r), r instanceof Error ? (r.stack ?? '') : '');
  });
}
