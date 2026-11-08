/**
 * The bottom prompt bar: pick the project folder the office works on, and talk to ARES (the Floor
 * Manager). ARES breaks the request down, files it in beads (epic + one issue per job, with
 * dependencies and an assignee), and delegates it to the right desks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { asksForIdeas } from './asksForIdeas.js';
import { withImages } from './imageAttach.js';
import { ALLOWED_IMAGE_TYPES } from './imageAttach.js';
import { ImageStrip } from './ImageStrip.js';
import { smClient, type SmFolder } from './smClient.js';
import { SmIdeas } from './SmIdeas.js';
import { useImageAttach } from './useImageAttach.js';
import type { SuccessManager } from './useSuccessManager.js';
import { useVoice, voiceSupported } from './useVoice.js';
import { initVoiceOut, onVoiceChange, setVoiceMuted, voiceAvailable, voiceMuted } from './voiceOut.js';
const KIND_ICON: Record<string, string> = { node: '⬢', ios: '', rust: '⚙', python: '🐍', go: '◆', git: '⎇', folder: '📁' };

function FolderPicker({ sm, onClose }: { sm: SuccessManager; onClose: () => void }) {
  const [base, setBase] = useState<string | undefined>(undefined);
  const [data, setData] = useState<{ base: string; parent: string | null; entries: SmFolder[] } | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    smClient.folders(base).then((d) => { if (alive) setData(d); }).catch((e: Error) => { if (alive) setMsg(e.message); });
    return () => { alive = false; };
  }, [base]);

  const use = useCallback(async (f: { path: string; managedAs?: string | null }) => {
    setMsg(null);
    if (f.managedAs) { sm.setProject(f.managedAs); onClose(); return; }
    setBusy(f.path);
    try {
      const r = await smClient.addProject(f.path);
      await sm.reloadProjects();
      sm.setProject(r.name);
      sm.say('orchestrator', `New project: ${r.name}. Let's go!`);
      onClose();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  }, [sm, onClose]);

  return (
    <Modal isOpen onClose={onClose} title="Which project should the office work on?" zIndex={62} className="w-[620px]">
      <div className="px-10 pb-8 flex flex-col gap-8 text-text">
        <div className="text-2xs text-text-muted">
          Pick a folder. New ones get set up automatically: a task tracker (beads) and the right test commands, so the crew knows what “done” means.
        </div>
        {data && (
          <div className="flex items-center gap-6 text-2xs">
            <Button size="sm" disabled={!data.parent} onClick={() => data.parent && setBase(data.parent)} title="Up one folder">↑</Button>
            <span className="text-text-muted truncate">{data.base}</span>
          </div>
        )}
        <div className="flex flex-col gap-4 max-h-[340px] overflow-y-auto">
          {data?.entries.map((f) => (
            <div key={f.path} className="flex items-center gap-6 bg-bg-dark border-2 border-border p-6"
              style={f.managedAs === sm.project ? { borderColor: 'var(--color-accent-bright)' } : undefined}>
              <span className="w-[22px] text-center text-sm">{KIND_ICON[f.kind] ?? '📁'}</span>
              <button className="flex-1 min-w-0 text-left bg-transparent border-0 cursor-pointer text-text text-2xs truncate" onClick={() => setBase(f.path)} title="Open folder">
                {f.name} {f.managedAs && <span style={{ color: 'var(--color-status-success)' }}>· managed</span>}
              </button>
              <Button size="sm" variant={f.managedAs ? 'default' : 'accent'} disabled={busy !== null} onClick={() => use(f)}>
                {busy === f.path ? 'Setting up…' : f.managedAs === sm.project ? 'Current' : f.managedAs ? 'Use' : 'Add & use'}
              </Button>
            </div>
          ))}
        </div>
        <div className="flex gap-6">
          <input className="flex-1 bg-bg-dark border-2 border-border text-text text-2xs p-6 font-pixel outline-none focus:border-accent"
            placeholder="…or paste a folder path, e.g. ~/Downloads/Projects/my-app" value={manual} onChange={(e) => setManual(e.target.value)} />
          <Button size="sm" disabled={!manual.trim() || busy !== null}
            onClick={() => use({ path: manual.trim() })}>Add</Button>
        </div>
        {msg && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{msg}</div>}
      </div>
    </Modal>
  );
}

export function SmPromptBar({ sm, sidePanelOpen }: { sm: SuccessManager; sidePanelOpen?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [ideas, setIdeas] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [, bump] = useState(0);
  useEffect(() => { void initVoiceOut(); return onVoiceChange(() => bump((n) => n + 1)); }, []);
  const att = useImageAttach();
  const { images, uploading } = att;
  const fileInput = useRef<HTMLInputElement>(null);
  const sendRef = useRef<(t?: string) => Promise<void>>(async () => {});
  const voice = useVoice((t, final) => { setText(t); if (final) void sendRef.current(t); }, setNote);
  useEffect(() => { if (att.error) setNote(att.error); }, [att.error]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => { setNote(null); att.setError(null); }, 5000); return () => clearTimeout(t); }, [note]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!sm.enabled) return null;

  const send = async (override?: string) => {
    const body = override ?? text;
    if (!sm.project) { setPicking(true); return; }
    if (!body.trim() || uploading > 0) return;
    if (asksForIdeas(body)) { setIdeas(true); setText(''); sm.say('ideas', 'Here are five ideas!'); return; } // MUSE answers suggestion requests
    setBusy(true);
    try {
      await smClient.mission.create(sm.project, withImages(body, att.paths));
      sm.say('orchestrator', 'Got it! Breaking it down…');
      setText('');
      att.clear();
      setNote('ARES is planning it — watch the office.');
      void sm.refresh();
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };

  sendRef.current = send;

  return (
    <>
      {/* sits to the right of Pixel Agents' toolbar (bottom-left), never on top of it */}
      <div className="absolute bottom-10 z-20 flex items-stretch gap-4 pixel-panel p-4"
        style={{ left: 262, right: sidePanelOpen ? 16 : 64, maxWidth: 820 }}
        onDragOver={att.onDragOver} onDrop={att.onDrop}>
        <Button size="sm" onClick={() => setPicking(true)} title="Choose the project folder the office works on" className="whitespace-nowrap max-w-[150px] truncate">
          📁 {sm.project ?? 'Choose project'} ▾
        </Button>
        <input
          className="flex-1 min-w-0 bg-bg-dark border-2 border-border text-text text-xs px-8 font-pixel outline-none focus:border-accent"
          placeholder={sm.project ? `Tell ARES what you need in ${sm.project}…` : 'First choose a project →'}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <input ref={fileInput} type="file" accept={ALLOWED_IMAGE_TYPES.join(',')} multiple hidden
          onChange={(e) => { void att.attach(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <Button size="sm" onClick={() => fileInput.current?.click()} title="Attach images (or paste / drag them in)">
          {uploading > 0 ? '…' : '📎'}{images.length > 0 ? ` ${images.length}` : ''}
        </Button>
        {voiceAvailable() && (
          <Button size="sm" onClick={() => setVoiceMuted(!voiceMuted())} title={voiceMuted() ? 'Crew voice is muted' : 'Mute the crew voice'} aria-label="Crew voice">
            {voiceMuted() ? '🔇' : '🔊'}
          </Button>
        )}
        {voiceSupported() && (
          <Button size="sm" variant={voice.listening ? 'accent' : 'default'} onClick={() => (voice.listening ? voice.stop() : void voice.start())}
            title={voice.listening ? 'Listening… click to stop' : 'Talk to ARES by voice'} aria-label="Microphone">
            {voice.listening ? '🔴' : '🎤'}
          </Button>
        )}
        <Button size="sm" onClick={() => setIdeas(true)} title="Ideas: MUSE's 5 suggestions for this project" aria-label="Ideas">💡</Button>
        <Button size="sm" variant="accent" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? '…' : 'Send'}</Button>
      </div>
      {images.length > 0 && (
        <div className="absolute bottom-[64px] z-20 pixel-panel p-4" style={{ right: sidePanelOpen ? 16 : 64 }}>
          <ImageStrip images={images} onRemove={att.remove} />
        </div>
      )}
      {note && (
        <div className="absolute bottom-[64px] z-20 pixel-panel px-8 py-2 text-2xs" style={{ left: 262 }}>{note}</div>
      )}
      {ideas && <SmIdeas sm={sm} onClose={() => setIdeas(false)} />}
      {picking && <FolderPicker sm={sm} onClose={() => setPicking(false)} />}
    </>
  );
}
