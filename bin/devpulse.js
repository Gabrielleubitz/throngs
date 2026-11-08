'use strict';
/**
 * Dev pulse: the owner's day-to-day picture as a developer, with no AI. Scans every git repo in the projects folder
 * (branch, uncommitted files, unpushed/behind commits, last commit, what was committed in the last day) and asks
 * GitHub (one `gh api graphql` call) for CI on each default branch, open PRs/issues, security alerts and review
 * requests. Ranked into `attention()` items. Used by IVY (calls, WhatsApp, morning brief), `sm today` and the
 * mission planner (repo state for the project being worked on). Cache: office/devpulse.json (personal, gitignored).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DAY_MS = 86400000;
const DORMANT_MS = 45 * DAY_MS; // untouched this long = an old project: mention it, never nag about it
const clip = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const ago = (iso, now) => { const ms = now - Date.parse(iso || ''); if (!(ms >= 0)) return ''; const h = Math.round(ms / 3600000); return h < 1 ? 'just now' : h < 36 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };

const GH_QUERY = `query{viewer{login
 pullRequests(states:OPEN,first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{title url isDraft reviewDecision mergeable repository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}
 repositories(first:30,orderBy:{field:PUSHED_AT,direction:DESC},ownerAffiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER]){nodes{nameWithOwner pushedAt isArchived isFork defaultBranchRef{name target{... on Commit{messageHeadline statusCheckRollup{state contexts(first:20){nodes{... on CheckRun{name conclusion} ... on StatusContext{context state}}}}}}} issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount} vulnerabilityAlerts(first:1,states:OPEN){totalCount}}}}
 rr:search(query:"is:open is:pr review-requested:@me archived:false",type:ISSUE,first:10){nodes{... on PullRequest{title url repository{nameWithOwner}}}}
 asg:search(query:"is:open assignee:@me archived:false",type:ISSUE,first:10){nodes{... on Issue{title url repository{nameWithOwner}} ... on PullRequest{title url repository{nameWithOwner}}}}}`;

/** `owner/name` from a git remote URL (https or ssh, incl. ssh://git@ssh.github.com:443/). */
function ghSlug(url) { const m = String(url || '').match(/github\.com[:/](?:\d+\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i); return m ? m[1] : ''; }

function createDevPulse(root, { roots, exec, now = () => Date.now(), ghTimeoutMs = 20000 } = {}) {
  const file = path.join(root, 'office', 'devpulse.json');
  // async so the office server never stalls while ~30 repos and GitHub are read
  const run = exec || ((cmd, args, cwd, timeout = 5000) => new Promise((res, rej) => execFile(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 8 << 20 }, (e, out) => (e ? rej(e) : res(String(out).trim())))));
  const git = async (cwd, ...a) => { try { return await run('git', ['-c', 'core.quotepath=off', ...a], cwd); } catch { return null; } };
  let cache = null; let busy = null;
  const scanRoots = () => roots || [path.resolve(root, '..')];

  /** Every git repo directly inside the roots (plus nested one level for monorepo-style folders). */
  function repoDirs() {
    const out = [];
    for (const r of scanRoots()) {
      let names = []; try { names = fs.readdirSync(r, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name); } catch { continue; }
      for (const n of names) {
        const d = path.join(r, n);
        if (fs.existsSync(path.join(d, '.git'))) { out.push(d); continue; }
        try { for (const m of fs.readdirSync(d, { withFileTypes: true })) if (m.isDirectory() && !m.name.startsWith('.') && m.name !== 'node_modules' && fs.existsSync(path.join(d, m.name, '.git'))) out.push(path.join(d, m.name)); } catch { /* unreadable */ }
      }
    }
    return out;
  }

  async function scanRepo(dir) {
    const t = now();
    const [branch, remote, st, ab, last, today] = await Promise.all([git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), git(dir, 'remote', 'get-url', 'origin'), git(dir, 'status', '--porcelain=v1'),
      git(dir, 'rev-list', '--left-right', '--count', '@{u}...HEAD'), git(dir, 'log', '-1', '--format=%cI%x09%s'), git(dir, 'log', `--since=${new Date(t - DAY_MS).toISOString()}`, '--format=%s', '-n', '15')]);
    const r = { name: path.basename(dir), path: dir, branch: branch || '?', dirty: 0, untracked: 0, ahead: 0, behind: 0, upstream: true, last: null, today: [], slug: ghSlug(remote) };
    if (st) for (const l of st.split('\n')) { if (l.startsWith('??')) r.untracked++; else if (l.trim()) r.dirty++; }
    if (ab) { const [b, a] = ab.split(/\s+/).map(Number); r.behind = b || 0; r.ahead = a || 0; } else r.upstream = false;
    if (last) { const [at, ...s] = last.split('\t'); r.last = { at, subject: clip(s.join('\t'), 80) }; }
    if (today) r.today = today.split('\n').filter(Boolean).map((s) => clip(s, 80));
    return r;
  }

  async function scanGitHub() {
    let j;
    try { j = JSON.parse(await run('gh', ['api', 'graphql', '-f', `query=${GH_QUERY}`], root, ghTimeoutMs)); } catch (e) { return { error: `GitHub unavailable (${clip(e.message, 60)})` }; }
    const v = j?.data?.viewer; if (!v) return { error: 'GitHub returned nothing' };
    const rollup = (c) => c?.statusCheckRollup?.state || null;
    const repos = (v.repositories?.nodes || []).filter((x) => x && !x.isArchived).map((x) => {
      const head = x.defaultBranchRef?.target || {};
      const failing = (head.statusCheckRollup?.contexts?.nodes || []).filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.conclusion || c.state)).map((c) => c.name || c.context);
      return { slug: x.nameWithOwner, pushedAt: x.pushedAt, fork: x.isFork, branch: x.defaultBranchRef?.name || '', ci: rollup(head), failing, headline: clip(head.messageHeadline, 80), issues: x.issues?.totalCount || 0, prs: x.pullRequests?.totalCount || 0, alerts: x.vulnerabilityAlerts?.totalCount || 0 };
    });
    const myPrs = (v.pullRequests?.nodes || []).map((p) => ({ title: clip(p.title, 80), url: p.url, repo: p.repository?.nameWithOwner, draft: p.isDraft, review: p.reviewDecision, mergeable: p.mergeable, ci: rollup(p.commits?.nodes?.[0]?.commit) }));
    const items = (s) => (s?.nodes || []).filter((x) => x && x.title).map((x) => ({ title: clip(x.title, 80), url: x.url, repo: x.repository?.nameWithOwner }));
    return { login: v.login, repos, myPrs, reviewRequests: items(j.data.rr), assigned: items(j.data.asg) };
  }

  /** Full scan (local + GitHub, in parallel). Writes the cache. Resolves to the data; one scan at a time. */
  function refresh() {
    if (busy) return busy;
    busy = (async () => {
      const [repos, github] = await Promise.all([Promise.all(repoDirs().map(scanRepo)), scanGitHub()]);
      const data = { at: new Date(now()).toISOString(), repos, github };
      cache = data;
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1)); fs.renameSync(`${file}.tmp`, file); } catch { /* cache is optional */ }
      return data;
    })().finally(() => { busy = null; });
    return busy;
  }
  const empty = () => ({ at: new Date(0).toISOString(), repos: [], github: { error: 'not scanned yet' } });
  /** What we have now, synchronously (never blocks). Kicks off a background scan when older than maxAgeMs. */
  function current(maxAgeMs = 15 * 60000) {
    if (!cache) { try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no cache yet */ } }
    if (!cache || now() - Date.parse(cache.at) > maxAgeMs) refresh().catch(() => {});
    return cache || empty();
  }
  /** Fresh enough data, waiting for a scan if needed (CLI, morning brief). */
  async function fresh(maxAgeMs = 15 * 60000) { const c = current(maxAgeMs); return now() - Date.parse(c.at) > maxAgeMs ? refresh() : c; }

  /** What deserves the owner's attention, most urgent first. Each: { level 0-3, text, repo }. */
  function attention(d = current()) {
    const t = now(); const out = [];
    const gh = d.github || {}; const ghRepos = gh.repos || [];
    for (const g of ghRepos) {
      if (g.fork) continue;
      const dormant = t - Date.parse(g.pushedAt || 0) > DORMANT_MS;
      if (['FAILURE', 'ERROR'].includes(g.ci)) out.push({ level: dormant ? 3 : 0, repo: g.slug, text: `${g.slug.split('/')[1]}: checks failing on ${g.branch}${g.failing.length ? ` (${g.failing.slice(0, 2).join(', ')})` : ''}` });
      if (g.alerts) out.push({ level: 0, repo: g.slug, text: `${g.slug.split('/')[1]}: open security alert${g.alerts > 1 ? 's' : ''}` });
    }
    for (const p of gh.reviewRequests || []) out.push({ level: 1, repo: p.repo, text: `Review requested: ${p.title} (${p.repo})` });
    for (const p of gh.myPrs || []) {
      if (['FAILURE', 'ERROR'].includes(p.ci)) out.push({ level: 1, repo: p.repo, text: `Your PR is failing checks: ${p.title}` });
      else if (p.review === 'APPROVED' && p.mergeable === 'MERGEABLE' && !p.draft) out.push({ level: 1, repo: p.repo, text: `Ready to merge: ${p.title}` });
      else if (p.review === 'CHANGES_REQUESTED') out.push({ level: 1, repo: p.repo, text: `Changes requested on: ${p.title}` });
    }
    for (const i of gh.assigned || []) out.push({ level: 2, repo: i.repo, text: `Assigned to you: ${i.title}` });
    const me = String(gh.login || '').toLowerCase();
    for (const r of d.repos || []) {
      if (me && r.slug && r.slug.split('/')[0].toLowerCase() !== me) { r.ahead = 0; r.behind = 0; } // someone else's repo (e.g. pixel-office's upstream): never pushed by design
      const old = r.last && t - Date.parse(r.last.at) > DAY_MS;
      const dormant = !r.last || t - Date.parse(r.last.at) > DORMANT_MS;
      if (dormant) { if (r.ahead || r.dirty) out.push({ level: 3, repo: r.name, text: `${r.name} (untouched ${r.last ? ago(r.last.at, t) : 'for ages'}): ${[r.ahead && `${r.ahead} unpushed`, r.dirty && `${r.dirty} uncommitted`].filter(Boolean).join(', ')}` }); continue; }
      if (r.ahead) out.push({ level: old ? 1 : 2, repo: r.name, text: `${r.name}: ${r.ahead} commit${r.ahead > 1 ? 's' : ''} not pushed${old ? ` (since ${ago(r.last.at, t)})` : ''}` });
      if (r.dirty) out.push({ level: old ? 2 : 3, repo: r.name, text: `${r.name}: ${r.dirty} uncommitted change${r.dirty > 1 ? 's' : ''} on ${r.branch}${old ? `, last commit ${ago(r.last.at, t)}` : ''}` });
      if (r.behind) out.push({ level: 2, repo: r.name, text: `${r.name}: ${r.behind} commit${r.behind > 1 ? 's' : ''} behind the remote (pull before working)` });
    }
    return out.sort((a, b) => a.level - b.level);
  }

  /** What got committed across all repos in the last day. */
  const yesterday = (d = current()) => (d.repos || []).filter((r) => r.today.length).map((r) => ({ repo: r.name, commits: r.today }));

  /** Plain-text block for IVY's prompt. */
  function context(d = current()) {
    const att = attention(d).slice(0, 12); const y = yesterday(d);
    const gh = d.github || {};
    const ci = (gh.repos || []).filter((g) => !g.fork).slice(0, 10).map((g) => `${g.slug.split('/')[1]} ${g.ci ? g.ci.toLowerCase() : 'no checks'}, pushed ${ago(g.pushedAt, now())}${g.prs ? `, ${g.prs} open PR` : ''}${g.issues ? `, ${g.issues} open issues` : ''}`);
    return [`Dev pulse (scanned ${ago(d.at, now())}${gh.error ? `; ${gh.error}` : ''}):`,
      `Needs attention:\n${att.map((a) => `- ${a.text}`).join('\n') || '- nothing: all pushed, all green'}`,
      `Committed in the last 24h:\n${y.map((r) => `- ${r.repo}: ${r.commits.slice(0, 4).join('; ')}${r.commits.length > 4 ? ` (+${r.commits.length - 4} more)` : ''}`).join('\n') || '- nothing'}`,
      `GitHub repos (latest first): ${ci.join(' | ') || 'unknown'}`].join('\n');
  }

  /** One or two spoken sentences. */
  function spoken(d = current()) {
    const att = attention(d).filter((a) => a.level <= 2);
    if (!att.length) return 'Your repos look good: everything is pushed and the checks are green.';
    const top = att.slice(0, 2).map((a) => a.text.replace(/\s*\(.*?\)\s*$/, '')).join('. ');
    return `${top}.${att.length > 2 ? ` Plus ${att.length - 2} smaller thing${att.length - 2 > 1 ? 's' : ''}.` : ''}`;
  }

  /** Repo state for a mission planner working in `dir`: branch, uncommitted work, recent commits, CI. */
  async function forProject(dir) {
    if (!dir || !fs.existsSync(path.join(dir, '.git'))) return '';
    const r = await scanRepo(dir);
    const log = (await git(dir, 'log', '-8', '--format=%h %s (%cr)')) || '';
    let ci = null; try { ci = (current(6 * 60 * 60000).github?.repos || []).find((g) => g.slug === r.slug) || null; } catch { /* optional */ }
    return [`Repo state (${r.name}, branch ${r.branch}${r.slug ? `, GitHub ${r.slug}` : ''}):`,
      `- ${r.dirty} uncommitted, ${r.untracked} untracked file(s); ${r.upstream ? `${r.ahead} ahead / ${r.behind} behind the remote` : 'no upstream'}`,
      ci ? `- CI on ${ci.branch}: ${ci.ci || 'no checks'}${ci.failing.length ? ` (failing: ${ci.failing.join(', ')})` : ''}; ${ci.prs} open PR(s), ${ci.issues} open issue(s)${ci.alerts ? `, ${ci.alerts} security alert(s)` : ''}` : '',
      `- Recent commits:\n${log.split('\n').filter(Boolean).map((l) => `  ${clip(l, 100)}`).join('\n')}`].filter(Boolean).join('\n');
  }

  return { refresh, current, fresh, attention, yesterday, context, spoken, forProject, file, _scanRepo: scanRepo };
}

module.exports = { createDevPulse, ghSlug };
