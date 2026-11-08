/**
 * Microphone for the prompt bar: browser speech-to-text fills the prompt; an AnalyserNode on the same
 * mic feeds voiceLevel so the whole office reacts to the owner's voice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { setVoice } from './voiceLevel.js';

interface Rec {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void;
}
type RecCtor = new () => Rec;

export function voiceSupported(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function useVoice(onText: (text: string, final: boolean) => void, onError: (msg: string) => void) {
  const [listening, setListening] = useState(false);
  const rec = useRef<Rec | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const cb = useRef({ onText, onError });
  cb.current = { onText, onError };

  const stop = useCallback(() => {
    rec.current?.stop();
    cleanup.current?.();
    cleanup.current = null;
    setVoice(0, false);
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { cb.current.onError('Voice input needs Chrome, Edge or Safari.'); return; }
    let stream: MediaStream | null = null;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { cb.current.onError('Microphone blocked — allow it in the browser.'); return; }
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let smooth = 0;
    let raf = 0;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      smooth = smooth * 0.7 + Math.min(1, Math.sqrt(sum / buf.length) * 5) * 0.3;
      setVoice(smooth, true);
      raf = requestAnimationFrame(tick);
    };
    tick();
    cleanup.current = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); void ctx.close(); };

    const r = new Ctor();
    r.continuous = false;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    let finalText = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      cb.current.onText((finalText + interim).trim(), false);
    };
    r.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') cb.current.onError(`Voice error: ${e.error}`); };
    r.onend = () => { cleanup.current?.(); cleanup.current = null; setVoice(0, false); setListening(false); if (finalText.trim()) cb.current.onText(finalText.trim(), true); };
    rec.current = r;
    r.start();
    setListening(true);
  }, []);

  useEffect(() => () => { rec.current?.stop(); cleanup.current?.(); setVoice(0, false); }, []);
  return { listening, start, stop };
}
