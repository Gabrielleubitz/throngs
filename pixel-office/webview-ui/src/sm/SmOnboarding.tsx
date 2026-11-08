/**
 * First-run onboarding: welcome, the intro video (only when one ships), what the app does, the setup checklist (what
 * this machine still needs, with the exact fix for each: bin/setup-check.js via /sm/setup), and a launch step.
 * Replay any time from the TOUR button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { smClient,type SmSetup, type SmSetupItem } from './smClient.js';

const FEATURES = [
  { icon: '🏢', title: 'A crew that works', text: 'Planners, builders and reviewers, each with a name and a desk. Watch them work in a live pixel office, or walk through it in 3D.' },
  { icon: '🎯', title: 'Missions, not prompts', text: 'Say what you want in plain words. The Floor Manager plans it, a team builds it, and an independent check decides if it passed.' },
  { icon: '🙋', title: 'Asks only when it must', text: 'When a person is truly needed (a key, a decision, a device test) the crew stops and asks, in simple words.' },
  { icon: '🦁', title: 'The Zoo', text: 'Link Google, Slack, WhatsApp, Notion and more. Each service is an animal your crew can send work through.' },
  { icon: '📞', title: 'Meetings with videos', text: 'Finished a video or report? The Conference Room calls you in and walks you through it.' },
  { icon: '🛡️', title: 'Guard rails', text: 'Workers cannot touch their own checks, push code, or leave their folder. You stay in charge.' },
];

const ALL_STEPS = ['Welcome', 'See it', 'Features', 'Setup', 'Go'] as const;
const GROUPS: { id: SmSetupItem['group']; title: string; note: string }[] = [
  { id: 'required', title: 'Needed to run', note: 'The crew can’t start work until these are green.' },
  { id: 'recommended', title: 'Recommended', note: '' },
  { id: 'optional', title: 'Optional features', note: 'Turn these on whenever you want them. Nothing breaks without them.' },
];

function SetupItem({ item, onEnv }: { item: SmSetupItem; onEnv: () => void }) {
  const [copied, setCopied] = useState(false);
  const icon = item.ok ? '✅' : item.group === 'required' ? '❌' : '⚪';
  const copy = () => { void navigator.clipboard?.writeText(item.cmd ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return (
    <div className="border-2 bg-bg p-10" style={{ borderColor: !item.ok && item.group === 'required' ? 'var(--color-danger)' : 'var(--color-border)' }} data-testid={`sm-setup-${item.id}`}>
      <div className="text-lg flex items-center gap-6"><span>{icon}</span><span className="flex-1">{item.label}</span></div>
      {item.unlocks && !item.ok && <div className="text-sm mt-2" style={{ color: 'var(--color-sm-gold)' }}>Unlocks: {item.unlocks}</div>}
      {!item.ok && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="text-base text-text-muted">{item.fix}</div>
          <div className="flex flex-wrap gap-4 items-center">
            {item.cmd && (
              <>
                <code className="px-6 py-2 bg-bg-dark border-2 border-border select-all" style={{ fontSize: 13 }}>{item.cmd}</code>
                <button className="px-6 py-2 text-sm border-2 border-border bg-btn-bg hover:bg-btn-hover cursor-pointer" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
              </>
            )}
            {item.action === 'create-env' && <button className="px-6 py-2 text-sm border-2 border-border cursor-pointer" style={{ background: 'var(--color-accent-bright)', color: 'var(--color-bg)' }} onClick={onEnv}>Create .env</button>}
            {item.link && <a className="text-sm" href={item.link} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent-bright)' }}>Open ↗</a>}
          </div>
        </div>
      )}
    </div>
  );
}

export function SmOnboarding({ forceOpen, onClose }: { forceOpen: boolean; onClose: () => void }) {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  const [video, setVideo] = useState<string | null>(null);
  const [videoErr, setVideoErr] = useState(false);
  const [setup, setSetup] = useState<SmSetup | null>(null);
  const [setupErr, setSetupErr] = useState('');
  const [hasVideo, setHasVideo] = useState(false);
  const urlRef = useRef<string | null>(null);
  const STEPS = hasVideo ? ALL_STEPS : ALL_STEPS.filter((s) => s !== 'See it'); // no intro video shipped: skip that step
  const cur = STEPS[Math.min(step, STEPS.length - 1)];

  useEffect(() => {
    if (forceOpen) { setStep(0); setShow(true); return; }
    let live = true;
    smClient.onboarding.status().then((s) => { if (!live) return; setHasVideo(s.hasVideo); if (!s.done) setShow(true); }).catch(() => { /* no bridge: skip */ });
    return () => { live = false; };
  }, [forceOpen]);
  useEffect(() => { if (forceOpen) smClient.onboarding.status().then((s) => setHasVideo(s.hasVideo)).catch(() => {}); }, [forceOpen]);

  useEffect(() => {
    if (!show || cur !== 'See it' || video || videoErr) return;
    let live = true;
    smClient.onboarding.video().then((u) => { if (live) { urlRef.current = u; setVideo(u); } else URL.revokeObjectURL(u); }).catch(() => { if (live) setVideoErr(true); });
    return () => { live = false; };
  }, [show, cur, video, videoErr]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const recheck = useCallback(() => smClient.setup.check().then((r) => { setSetup(r); setSetupErr(''); }).catch((e: Error) => setSetupErr(e.message)), []);
  useEffect(() => { // re-check every few seconds while the checklist is open, so fixes made in a terminal turn green by themselves
    if (!show || cur !== 'Setup') return;
    void recheck();
    const t = setInterval(() => { void recheck(); }, 4000);
    return () => clearInterval(t);
  }, [show, cur, recheck]);
  const createEnv = useCallback(() => { smClient.setup.createEnv().then(setSetup).catch((e: Error) => setSetupErr(e.message)); }, []);

  const finish = useCallback(() => {
    void smClient.onboarding.complete().catch(() => { /* retried next launch */ });
    setShow(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!show) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(s + 1, STEPS.length - 1));
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(s - 1, 0));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [show, finish, STEPS.length]);

  if (!show) return null;
  const last = step === STEPS.length - 1;
  const btn = 'px-12 py-6 text-lg border-2 border-border bg-btn-bg hover:bg-btn-hover cursor-pointer';
  return (
    <div className="sm-ob-backdrop fixed inset-0 z-[300] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Welcome to Throngs" data-testid="sm-onboarding">
      <div className="sm-ob-grid absolute inset-0 pointer-events-none" />
      <div className="relative flex items-center justify-between px-16 py-10">
        <div className="flex gap-6" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <button key={s} onClick={() => setStep(i)} title={s} aria-label={s} className="h-8 border-0 cursor-pointer"
              style={{ width: i === step ? 36 : 14, background: i <= step ? 'var(--color-accent-bright)' : 'var(--color-border)', transition: 'width 0.2s' }} />
          ))}
        </div>
        <button onClick={finish} className="text-sm text-text-muted bg-transparent border-0 cursor-pointer" data-testid="sm-onboarding-skip">Skip ✕</button>
      </div>

      <div key={step} className={`sm-ob-step relative flex-1 min-h-0 overflow-auto flex flex-col items-center px-24 text-center gap-14 ${cur === 'Setup' ? 'justify-start py-12' : 'justify-center'}`}>
        {cur === 'Welcome' && (
          <>
            <div className="sm-ob-float text-[64px]" aria-hidden>🏢</div>
            <h1 className="sm-ob-title text-[56px] leading-none m-0">THRONGS</h1>
            <p className="text-2xl m-0" style={{ color: 'var(--color-sm-gold)' }}>Your coding crew, in a pixel office.</p>
            <p className="text-lg text-text-muted m-0 max-w-[560px]">Tell it what you want built. A team of AI workers plans it, builds it and checks it, while you watch, or go for a walk.</p>
          </>
        )}
        {cur === 'See it' && (
          <>
            <h2 className="text-3xl m-0">See it in action</h2>
            <div className="border-2 border-border bg-bg-dark w-full max-w-[860px] aspect-video flex items-center justify-center" >
              {video ? <video src={video} controls autoPlay playsInline className="w-full h-full" data-testid="sm-onboarding-video" />
                : videoErr ? <span className="text-text-muted">The intro video isn&apos;t available here. You can skip ahead.</span>
                : <span className="text-text-muted">Loading the intro…</span>}
            </div>
            <p className="text-base text-text-muted m-0">2 minutes. It shows the crew, missions and meetings exactly as you&apos;ll use them.</p>
          </>
        )}
        {cur === 'Features' && (
          <>
            <h2 className="text-3xl m-0">What you get</h2>
            <div className="grid gap-10 w-full max-w-[960px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              {FEATURES.map((f, i) => (
                <div key={f.title} className="sm-ob-card text-left border-2 border-border bg-bg p-12" style={{ animationDelay: `${i * 70}ms` }}>
                  <div className="text-2xl">{f.icon} <span className="text-lg" style={{ color: 'var(--color-sm-gold)' }}>{f.title}</span></div>
                  <p className="text-base text-text-muted mt-6 mb-0">{f.text}</p>
                </div>
              ))}
            </div>
          </>
        )}
        {cur === 'Setup' && (
          <>
            <h2 className="text-3xl m-0">Get set up</h2>
            {setup && (
              <div className="w-full max-w-[720px]">
                <div className="flex justify-between text-base mb-4">
                  <span>{setup.ready ? '✅ Ready to work' : `Needed to run: ${setup.required.done} of ${setup.required.total}`}</span>
                  <button className="text-sm text-text-muted bg-transparent border-0 cursor-pointer" onClick={() => { void recheck(); }}>↻ Re-check</button>
                </div>
                <div className="h-8 border-2 border-border bg-bg-dark"><div className="h-full" style={{ width: `${(100 * setup.required.done) / setup.required.total}%`, background: setup.ready ? 'var(--color-status-success)' : 'var(--color-accent-bright)', transition: 'width 0.3s' }} /></div>
              </div>
            )}
            <div className="flex flex-col gap-12 w-full max-w-[720px] text-left">
              {setup && GROUPS.map((g) => (
                <div key={g.id} className="flex flex-col gap-6">
                  <div className="text-lg" style={{ color: 'var(--color-sm-gold)' }}>{g.title}{g.note && <span className="text-sm text-text-muted"> · {g.note}</span>}</div>
                  {setup.items.filter((x) => x.group === g.id).map((x) => <SetupItem key={x.id} item={x} onEnv={createEnv} />)}
                </div>
              ))}
              {!setup && !setupErr && <span className="text-text-muted text-center">Checking this machine…</span>}
              {setupErr && <span className="text-center" style={{ color: 'var(--color-danger)' }}>Couldn&apos;t check: {setupErr}</span>}
            </div>
            <p className="text-base text-text-muted m-0">This list updates by itself as you fix things. In a terminal: <code style={{ fontSize: 13 }}>node bin/sm.js doctor</code></p>
          </>
        )}
        {cur === 'Go' && (
          <>
            <div className="sm-ob-float text-[64px]" aria-hidden>🚀</div>
            <h2 className="sm-ob-title text-5xl leading-none m-0">YOU&apos;RE IN</h2>
            <p className="text-lg text-text-muted m-0 max-w-[560px]">Add a project, then type what you want in the bar at the bottom. Press TOUR any time to see this again.</p>
            {setup && !setup.ready && (
              <p className="text-base m-0 max-w-[560px]" style={{ color: 'var(--color-danger)' }}>
                Still needed before the crew can work: {setup.items.filter((x) => x.group === 'required' && !x.ok).map((x) => x.label).join(', ')}. <button className="bg-transparent border-0 underline cursor-pointer text-base" style={{ color: 'inherit' }} onClick={() => setStep(STEPS.indexOf('Setup'))}>Back to setup</button>
              </p>
            )}
          </>
        )}
      </div>

      <div className="relative flex items-center justify-between px-16 py-12">
        <button className={btn} style={{ visibility: step === 0 ? 'hidden' : 'visible' }} onClick={() => setStep(step - 1)}>← Back</button>
        <button className={btn} style={{ background: 'var(--color-accent-bright)', color: 'var(--color-bg)' }} onClick={last ? finish : () => setStep(step + 1)} data-testid="sm-onboarding-next" autoFocus>
          {last ? 'Enter the office' : step === 0 ? 'Show me' : 'Next →'}
        </button>
      </div>
    </div>
  );
}
