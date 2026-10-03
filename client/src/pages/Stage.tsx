import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RoomView } from '@nemo/shared';
import { Board, themeList } from '../canvas/Board';
import { tr } from '../i18n';
import { FactToasts, NemoFace, SummaryModal, Transcript } from '../ui/panels';

// The shared screen: a whiteboard that Nemo fills with cards. Nothing else.

const TOUR_STEP_MS = 5000;

export function Stage({ view, controls }: { view: RoomView; controls?: ReactNode; role: 'host' | 'viewer' }) {
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [topicOpen, setTopicOpen] = useState(false);
  // A click on the theme bar focuses locally; the most recent request (voice or click) wins.
  const [localFocus, setLocalFocus] = useState<RoomView['focus']>(null);
  const requested = !localFocus || (view.focus && view.focus.at > localFocus.at) ? (view.focus ?? null) : localFocus;
  const themes = themeList(view.canvas);
  // Guided tour: each theme for TOUR_STEP_MS, then back to following the talk.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (requested?.kind !== 'tour') return;
    const timer = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(timer);
  }, [requested]);
  void tick;
  const step = requested?.kind === 'tour' ? Math.floor((Date.now() - requested.at) / TOUR_STEP_MS) : -1;
  const tourRef = step >= 0 && step < themes.length ? themes[step].id : undefined;
  // Stable object: the board only re-frames when the target really changes.
  const focus = useMemo<RoomView['focus']>(
    () =>
      requested?.kind === 'tour'
        ? tourRef
          ? { kind: 'cluster', ref: tourRef, at: requested.at + step * TOUR_STEP_MS }
          : null
        : requested,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requested?.kind, requested?.ref, requested?.at, tourRef, step],
  );
  // Refresh the highlighted chip when a focus expires.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!focus) return;
    const ms = 25_000 - (Date.now() - focus.at);
    if (ms <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), ms + 50);
    return () => clearTimeout(timer);
  }, [focus]);
  const focusedTheme = focus?.kind === 'cluster' && Date.now() - focus.at < 25_000 ? focus.ref : undefined;
  const empty = view.canvas.cards.length === 0;
  return (
    <div className="relative h-dvh w-full overflow-hidden bg-cream">
      <Board state={view.canvas} lang={view.lang} focus={focus} />

      {empty && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="text-center max-w-md px-6">
            <div className="mx-auto w-fit">
              <NemoFace mode={view.mode} size={88} />
            </div>
            <h2 className="mt-4 font-display font-extrabold text-3xl">{tr(view.lang, 'emptyTitle')}</h2>
          </div>
        </div>
      )}

      <div
        className={`absolute top-4 left-4 flex items-start gap-2 panel !shadow-brut-sm bg-white/95 px-3 py-2 z-10 ${topicOpen ? 'max-w-[min(560px,calc(100vw-32px))]' : 'max-w-[30vw]'}`}
      >
        <NemoFace mode={view.mode} size={44} />
        <div className="min-w-0">
          <div className="font-display font-extrabold text-xl leading-none">Nemo</div>
          {view.canvas.topic && (
            <button
              className={`text-left text-sm font-bold opacity-70 mt-1 cursor-pointer hover:opacity-100 ${topicOpen ? '' : 'line-clamp-2'}`}
              title={topicOpen ? '' : view.canvas.topic}
              onClick={() => setTopicOpen(!topicOpen)}
            >
              {view.canvas.topic}
            </button>
          )}
        </div>
      </div>

      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
        <FactToasts cards={view.canvas.cards} popups={view.popups} />
      </div>

      <div className="absolute bottom-4 left-4 hidden md:block">
        <Transcript lines={view.transcript} lang={view.lang} />
      </div>

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 max-w-[calc(100vw-32px)] md:max-w-[calc(100vw-800px)] min-w-[280px]">
        {themes.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {themes.map((c, i) => (
              <button
                key={c.id}
                onClick={() => setLocalFocus({ kind: 'cluster', ref: c.id, at: Date.now() })}
                className={`chip !py-0.5 !text-[13px] cursor-pointer ${focusedTheme === c.id ? 'bg-sun' : 'bg-white'}`}
                title={c.label}
              >
                <span className="opacity-60">{i + 1}</span>
                <span className="max-w-[130px] truncate">{c.label}</span>
              </button>
            ))}
            <button onClick={() => setLocalFocus({ kind: 'all', at: Date.now() })} className={`chip !py-0.5 !text-[13px] cursor-pointer ${focus?.kind === 'all' && Date.now() - focus.at < 25_000 ? 'bg-sun' : 'bg-brand-soft'}`}>
              {view.lang === 'fr' ? 'Vue d’ensemble' : 'Overview'}
            </button>
          </div>
        )}
        {controls}
      </div>

      {view.summary && summaryOpen && <SummaryModal summary={view.summary} code={view.code} lang={view.lang} onClose={() => setSummaryOpen(false)} />}
    </div>
  );
}
