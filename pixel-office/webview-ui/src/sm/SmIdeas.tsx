/**
 * Future Ideas (MUSE, Control Room): one tab per department (Features, Design, Security, Bugs & quality,
 * Growth & copy), each with up to 5 ideas for the selected project and its own "Fresh ideas" pass that uses
 * that department's skills. "Give to planner" turns one into a mission (Planner drafts → ARES approves →
 * team → QA → security); "Add thoughts" refines it first.
 */
import { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { smClient,type SmIdea } from './smClient.js';
import type { SuccessManager } from './useSuccessManager.js';

function IdeaCard({ sm, idea, onMsg }: { sm: SuccessManager; idea: SmIdea; onMsg: (m: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); onMsg(done); await sm.refresh(); } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="bg-bg-dark border-2 border-border p-8 flex flex-col gap-4">
      <div className="text-xs">{idea.title}{idea.revisited && <span className="text-2xs text-text-muted"> · revisited</span>}</div>
      <div className="text-2xs text-text-muted">{idea.detail}</div>
      {idea.thoughts.map((t, i) => <div key={i} className="text-2xs" style={{ color: 'var(--color-accent-bright)' }}>💭 {t.text}</div>)}
      {adding && (
        <div className="flex gap-4">
          <input className="flex-1 min-w-0 bg-bg border-2 border-border text-text text-2xs p-4 font-pixel outline-none focus:border-accent"
            placeholder="Your thoughts on this idea…" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" disabled={busy || !text.trim()}
            onClick={() => act(async () => { await smClient.ideas.addThoughts(sm.project!, idea.id, text); setText(''); setAdding(false); }, 'Thoughts added — MUSE will fold them in.')}>Save</Button>
        </div>
      )}
      <div className="flex gap-4">
        <Button size="sm" variant="accent" disabled={busy || !sm.project} title={sm.project ? 'The Planner drafts it, ARES approves it' : 'Choose a project first'}
          onClick={() => act(() => smClient.ideas.givePlanner(sm.project!, idea.id), 'Handed to the Planner — watch the mission.')}>Give to planner</Button>
        <Button size="sm" disabled={busy} onClick={() => setAdding((v) => !v)}>Add thoughts</Button>
        <Button size="sm" disabled={busy} onClick={() => act(() => smClient.ideas.dismiss(sm.project!, idea.id), 'Dismissed.')}>Dismiss</Button>
      </div>
    </div>
  );
}

const FALLBACK_TABS = [{ id: 'features', label: 'Features' }];

export function SmIdeas({ sm, onClose }: { sm: SuccessManager; onClose: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const tabs = sm.state?.ideaCategories?.length ? sm.state.ideaCategories : FALLBACK_TABS;
  const [tab, setTab] = useState(tabs[0].id);
  const all = sm.state?.ideas ?? [];
  const ideas = all.filter((i) => (i.category ?? 'features') === tab);
  const st = sm.state?.ideasStatus?.[tab];
  const thinking = Boolean(st?.running);
  const label = tabs.find((t) => t.id === tab)?.label ?? tab;
  const fresh = async () => {
    if (!sm.project) return;
    try { await smClient.ideas.fresh(sm.project, tab); sm.say('ideas', `Looking for fresh ${label.toLowerCase()} ideas…`); setMsg(null); await sm.refresh(); }
    catch (e) { setMsg((e as Error).message); }
  };
  return (
    <Modal isOpen onClose={onClose} title={`MUSE · ideas for ${sm.project ?? 'this project'}`} zIndex={62} className="w-[640px]">
      <div className="px-10 pb-8 flex flex-col gap-6 text-text max-h-[70vh] overflow-y-auto">
        <div className="flex flex-wrap gap-4" role="tablist" aria-label="Idea departments">
          {tabs.map((t) => {
            const n = all.filter((i) => (i.category ?? 'features') === t.id).length;
            const busy = sm.state?.ideasStatus?.[t.id]?.running;
            return (
              <Button key={t.id} size="sm" role="tab" aria-selected={t.id === tab} variant={t.id === tab ? 'active' : 'default'} onClick={() => { setTab(t.id); setMsg(null); }}>
                {t.label}{busy ? ' ✨' : n ? ` · ${n}` : ''}
              </Button>
            );
          })}
        </div>
        <div className="flex items-center gap-6">
          <span className="flex-1 text-2xs text-text-muted">
            {thinking ? `MUSE is reading the project for 5 fresh ${label.toLowerCase()} ideas… (about a minute)` : `MUSE keeps the ${label} list until you ask for fresh ideas.`}
          </span>
          <Button size="sm" variant="accent" disabled={thinking || !sm.project} onClick={fresh} title={`One short ${label} pass over the project, using that department's skills (small usage cap)`}>
            {thinking ? '✨ Thinking…' : '✨ Fresh ideas'}
          </Button>
        </div>
        {st?.error && !thinking && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>Last attempt failed: {st.error}</div>}
        {ideas.map((i) => <IdeaCard key={i.id} sm={sm} idea={i} onMsg={setMsg} />)}
        {!ideas.length && !thinking && <div className="text-2xs text-text-muted">No {label.toLowerCase()} ideas for this project yet — click ✨ Fresh ideas.</div>}
        {msg && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
      </div>
    </Modal>
  );
}
