'use client';
// Mic button for the chat inputs (docs/06 "Voice input"). Tap to record, tap again to stop (Esc cancels; 2 min max).
// The clip goes to /api/transcribe (CEO only) → worker → Whisper (config/models.yaml `transcription`), and the text is
// handed to onText. The audio is never stored.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Loader2, Mic, Square } from 'lucide-react';
import { useHq } from '@/lib/data/store';
import { pickRecorderType, transcribeClip, MAX_RECORD_SECONDS } from '@/lib/voice';

type State = 'idle' | 'starting' | 'recording' | 'working';

export function VoiceButton({ onText, source, disabled, className }: {
  onText: (text: string) => void; source: string; disabled?: boolean; className?: string;
}) {
  const { toast } = useHq();
  const [state, setState] = useState<State>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [supported, setSupported] = useState(true);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; cancelled: boolean; timer: ReturnType<typeof setInterval> } | null>(null);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
    return () => { const r = rec.current; if (r) { r.cancelled = true; clearInterval(r.timer); r.recorder.state !== 'inactive' && r.recorder.stop(); r.stream.getTracks().forEach((t) => t.stop()); } };
  }, []);

  useEffect(() => {
    if (state !== 'recording') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(true); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const start = async () => {
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      setState('idle');
      toast(e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Microphone blocked. Allow it in the browser’s site settings, then try again.'
        : 'Couldn’t open the microphone.', 'error');
      return;
    }
    const mimeType = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const started = Date.now();
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setElapsed(s);
      if (s >= MAX_RECORD_SECONDS) stop(false);
    }, 250);
    rec.current = { recorder, stream, cancelled: false, timer };
    recorder.onstop = async () => {
      const r = rec.current;
      rec.current = null;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      if (!r || r.cancelled) { setState('idle'); return; }
      setState('working');
      const res = await transcribeClip(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }), source);
      setState('idle');
      if (!res.ok) { toast(res.error, 'error'); return; }
      if (!res.text) { toast('I didn’t catch any words. Try again a little closer to the mic.', 'info'); return; }
      onText(res.text);
    };
    recorder.start(250);
    setElapsed(0);
    setState('recording');
  };

  const stop = (cancel: boolean) => {
    const r = rec.current;
    if (!r) return;
    r.cancelled = cancel;
    if (r.recorder.state !== 'inactive') r.recorder.stop();
  };

  if (!supported) return null;
  const recording = state === 'recording';
  const busy = state === 'starting' || state === 'working';
  const label = recording ? 'Stop and transcribe' : state === 'working' ? 'Transcribing' : 'Speak instead of typing';
  return (
    <button type="button" onClick={() => (recording ? stop(false) : void start())} disabled={disabled || busy}
      aria-label={label} title={recording ? 'Tap to stop · Esc to cancel' : label} aria-pressed={recording}
      className={clsx('relative flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-sm transition-colors disabled:opacity-50',
        recording
          ? 'border-[color-mix(in_oklab,var(--color-danger)_60%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_18%,transparent)] text-[#ffb3b5]'
          : 'border-[var(--color-line)] bg-[#231f55]/65 text-[var(--color-muted)] hover:border-[var(--color-line-active)] hover:text-white',
        className)}>
      {recording ? (
        <>
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-danger)]" aria-hidden />
          <span className="font-mono tabular-nums">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
          <Square size={14} aria-hidden />
        </>
      ) : busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Mic size={18} aria-hidden />}
      <span className="sr-only" aria-live="polite">{recording ? 'Recording' : state === 'working' ? 'Transcribing' : ''}</span>
    </button>
  );
}
