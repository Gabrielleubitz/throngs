/** First-run onboarding: welcome, the intro video, what the app does, a setup check, and a launch step. Replay any time from the TOUR button. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { smClient } from './smClient.js';

const FEATURES = [
  { icon: '🏢', title: 'A crew that works', text: 'Planners, builders and reviewers, each with a name and a desk. Watch them work in a live pixel office, or walk through it in 3D.' },
  { icon: '🎯', title: 'Missions, not prompts', text: 'Say what you want in plain words. The Floor Manager plans it, a team builds it, and an independent check decides if it passed.' },
  { icon: '🙋', title: 'Asks only when it must', text: 'When a person is truly needed (a key, a decision, a device test) the crew stops and asks, in simple words.' },
  { icon: '🦁', title: 'The Zoo', text: 'Link Google, Slack, WhatsApp, Notion and more. Each service is an animal your crew can send work through.' },
  { icon: '📞', title: 'Meetings with videos', text: 'Finished a video or report? The Conference Room calls you in and walks you through it.' },
  { icon: '🛡️', title: 'Guard rails', text: 'Workers cannot touch their own checks, push code, or leave their folder. You stay in charge.' },
];

const STEPS = ['Welcome', 'See it', 'Features', 'Setup', 'Go'] as const;

interface Check { label: string; ok: boolean; hint: string; optional?: boolean }

export function SmOnboarding({ forceOpen, onClose }: { forceOpen: boolean; onClose: () => void }) {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  const [video, setVideo] = useState<string | null>(null);
  const [videoErr, setVideoErr] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (forceOpen) { setStep(0); setShow(true); return; }
    let live = true;
    smClient.onboarding.status().then((s) => { if (live && !s.done) setShow(true); }).catch(() => { /* no bridge: skip */ });
    return () => { live = false; };
  }, [forceOpen]);

  useEffect(() => {
    if (!show || step !== 1 || video || videoErr) return;
    let live = true;
    smClient.onboarding.video().then((u) => { if (live) { urlRef.current = u; setVideo(u); } else URL.revokeObjectURL(u); }).catch(() => { if (live) setVideoErr(true); });
    return () => { live = false; };
  }, [show, step, video, videoErr]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  useEffect(() => {
    if (!show || step !== 3) return;
    let live = true;
    Promise.all([smClient.voice().catch(() => ({ enabled: false })), smClient.integrations.list().catch(() => []), smClient.firebase.status().catch(() => ({ linked: false, projectId: null }))]).then(([v, ints, fb]) => {
      if (!live) return;
      const linked = ints.filter((i) => i.linked).length;
      setChecks([
        { label: 'Office is running', ok: true, hint: '' },
        { label: 'Crew voice (ElevenLabs)', ok: v.enabled, hint: 'Add ELEVENLABS_API_KEY to the .env file, then it turns on by itself.', optional: true },
        { label: `Zoo services linked: ${linked}`, ok: linked > 0, hint: 'Open the Zoo and link Google or Slack when you want the crew to send things.', optional: true },
        { label: fb.linked ? `Firebase backup: ${fb.projectId}` : 'Firebase backup', ok: fb.linked, hint: 'Run: node bin/sm.js firebase link key.json, to keep your linked services safe in the cloud.', optional: true },
      ]);
    });
    return () => { live = false; };
  }, [show, step]);

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
  }, [show, finish]);

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

      <div key={step} className="sm-ob-step relative flex-1 min-h-0 overflow-auto flex flex-col items-center justify-center px-24 text-center gap-14">
        {step === 0 && (
          <>
            <div className="sm-ob-float text-[64px]" aria-hidden>🏢</div>
            <h1 className="sm-ob-title text-[56px] leading-none m-0">THRONGS</h1>
            <p className="text-2xl m-0" style={{ color: 'var(--color-sm-gold)' }}>Your coding crew, in a pixel office.</p>
            <p className="text-lg text-text-muted m-0 max-w-[560px]">Tell it what you want built. A team of AI workers plans it, builds it and checks it, while you watch, or go for a walk.</p>
          </>
        )}
        {step === 1 && (
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
        {step === 2 && (
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
        {step === 3 && (
          <>
            <h2 className="text-3xl m-0">Quick setup check</h2>
            <div className="flex flex-col gap-6 w-full max-w-[640px] text-left">
              {(checks ?? []).map((c) => (
                <div key={c.label} className="border-2 border-border bg-bg p-10">
                  <div className="text-lg">{c.ok ? '✅' : c.optional ? '⚪' : '❌'} {c.label}</div>
                  {!c.ok && <div className="text-base text-text-muted mt-4">{c.hint}</div>}
                </div>
              ))}
              {!checks && <span className="text-text-muted text-center">Checking…</span>}
            </div>
            <p className="text-base text-text-muted m-0">Everything here is optional. You can do it later from the Zoo.</p>
          </>
        )}
        {step === 4 && (
          <>
            <div className="sm-ob-float text-[64px]" aria-hidden>🚀</div>
            <h2 className="sm-ob-title text-5xl leading-none m-0">YOU&apos;RE IN</h2>
            <p className="text-lg text-text-muted m-0 max-w-[560px]">Add a project, then type what you want in the bar at the bottom. Press TOUR any time to see this again.</p>
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
