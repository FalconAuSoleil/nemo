import { useEffect, useRef, useState } from 'react';
import {
  FastForwardIcon,
  MicrophoneIcon,
} from '@phosphor-icons/react';
import type { C2S, S2C } from '@nemo/shared';
import { BrowserAsr, PcmPlayer, VoiceDetector, speakWithBrowser, startMic, browserAsrSupported, type Mic } from '../audio/audio';
import { useRoom } from '../net/room';
import { NemoFace } from '../ui/panels';
import { Stage } from './Stage';
import { storedLang, tr, type UiKey } from '../i18n';

// The room PC: its microphone listens to everyone, its speakers carry Nemo's voice.

export function HostPage() {
  const [started, setStarted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const topic = useRef(sessionStorage.getItem('nemo.topic') ?? '');
  const lang = useRef(storedLang());
  const t = (k: UiKey) => tr(lang.current, k);
  const mic = useRef<Mic | null>(null);
  const asr = useRef<BrowserAsr | null>(null);
  const speaking = useRef(false);
  const connRef = useRef<ReturnType<typeof useRoom>[1] | null>(null);

  const applyMute = () => {
    const m = speaking.current;
    mic.current?.setMuted(m);
    asr.current?.setPaused(m);
  };
  const setSpeaking = (s: boolean) => {
    speaking.current = s;
    applyMute();
    connRef.current?.send({ t: 'playback', speaking: s });
  };

  const player = useRef<PcmPlayer>(new PcmPlayer((s) => setSpeaking(s)));

  // Nemo never talks over people: if someone speaks while it talks, it stops.
  const bargeIn = () => {
    player.current.stop();
    window.speechSynthesis?.cancel();
    connRef.current?.send({ t: 'interrupt' });
    setSpeaking(false);
  };
  const vad = useRef(new VoiceDetector((talking) => connRef.current?.send({ t: 'vad', speaking: talking }), bargeIn));

  const onSpecial = (msg: S2C) => {
    if (msg.t === 'say') {
      setSpeaking(true);
      speakWithBrowser(msg.text, () => setSpeaking(false), msg.lang ?? lang.current);
    } else if (msg.t === 'say.audio.start') player.current.begin(msg.sampleRate);
    else if (msg.t === 'say.audio.end') player.current.end();
  };

  const open: C2S | null = started ? { t: 'host.create', topic: topic.current || undefined, lang: lang.current } : null;
  const [state, conn] = useRoom(open, onSpecial, (buf) => player.current.push(buf));
  connRef.current = conn;
  const capabilities = state.view?.capabilities;

  // Start capture once the server told us which speech-to-text path to use.
  useEffect(() => {
    if (!capabilities || mic.current || asr.current) return;
    (async () => {
      try {
        // The mic always runs for voice detection; audio is streamed only to a server-side ASR.
        const streamAudio = capabilities.asr !== 'browser';
        mic.current = await startMic(
          (pcm) => streamAudio && connRef.current?.sendBinary(pcm),
          (rms) => vad.current.feed(rms, speaking.current),
        );
        if (!streamAudio) {
          if (!browserAsrSupported()) throw new Error(t('noAsr'));
          asr.current = new BrowserAsr((text, final) => connRef.current?.send({ t: 'utterance', text, final }), lang.current);
          asr.current.start();
        }
        applyMute();
      } catch (err) {
        setMicError(String((err as Error).message ?? err));
      }
    })();
  }, [capabilities]);

  useEffect(
    () => () => {
      mic.current?.stop();
      asr.current?.stop();
    },
    [],
  );

  // Keep the screen awake during the session.
  useEffect(() => {
    if (!started) return;
    let lock: WakeLockSentinel | null = null;
    const req = async () => {
      try {
        lock = await navigator.wakeLock?.request('screen');
      } catch {
        /* not critical */
      }
    };
    void req();
    const onVis = () => document.visibilityState === 'visible' && void req();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, [started]);

  if (!started) {
    return (
      <div className="h-dvh grid place-items-center bg-cream dotgrid p-6">
        <div className="panel !shadow-brut-lg p-8 max-w-lg w-full text-center">
          <div className="mx-auto w-fit">
            <NemoFace mode="listening" size={84} />
          </div>
          <h1 className="font-display font-extrabold text-3xl mt-4">{t('wakeTitle')}</h1>
          <p className="mt-2 opacity-70">{t('wakeBody')}</p>
          {topic.current && (
            <p className="mt-3 font-display font-bold">
              {t('topic')} : {topic.current}
            </p>
          )}
          <button
            className="btn bg-sun mt-6 !text-lg !px-6"
            onClick={() => {
              player.current.unlock();
              window.speechSynthesis?.getVoices();
              setStarted(true);
            }}
          >
            <MicrophoneIcon size={22} weight="bold" />
            {t('startListening')}
          </button>
        </div>
      </div>
    );
  }

  if (!state.view) {
    return (
      <div className="h-dvh grid place-items-center bg-cream">
        <div className="text-center">
          <NemoFace mode="thinking" size={72} />
          <p className="mt-3 font-display font-bold">{state.status === 'error' ? state.error : t('connecting')}</p>
        </div>
      </div>
    );
  }

  const send = (action: Extract<C2S, { t: 'control' }>['action']) => conn.send({ t: 'control', action });

  const controls = (
    <div className="flex flex-col items-center gap-2">
      {micError && <div className="chip bg-pink-soft !text-xs max-w-md">{micError}</div>}
      <button className="btn bg-sun" title={t('demoTitle')} onClick={() => send('demo')}>
        <FastForwardIcon size={18} weight="bold" />
        {t('demo')}
      </button>
    </div>
  );

  return <Stage view={state.view} controls={controls} role="host" />;
}
