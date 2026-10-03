import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowSquareOutIcon,
  BrainIcon,
  CheckIcon,
  DownloadSimpleIcon,
  EarIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  QuestionIcon,
  SparkleIcon,
  WaveformIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { AgentStatus, Card, Lang, MethodRun, NemoMode, Phase, Popup, SessionSummary, TranscriptLine } from '@nemo/shared';
import { PHASES } from '@nemo/shared';
import { Mascot } from './Mascot';
import { tr, type UiKey } from '../i18n';

// ---- Nemo status pill --------------------------------------------------------

const MODE: Record<NemoMode, { label: string; bg: string; Icon: typeof EarIcon }> = {
  idle: { label: 'Nemo is paused', bg: 'bg-white', Icon: MoonIcon },
  listening: { label: 'Nemo is listening', bg: 'bg-sun', Icon: EarIcon },
  thinking: { label: 'Nemo is thinking', bg: 'bg-lilac', Icon: BrainIcon },
  speaking: { label: 'Nemo is speaking', bg: 'bg-pink', Icon: WaveformIcon },
  researching: { label: 'Nemo is researching', bg: 'bg-brand text-white', Icon: MagnifyingGlassIcon },
};

export function NemoFace({ mode, size = 44 }: { mode: NemoMode; size?: number }) {
  return <Mascot mode={mode} size={size} />;
}

export function StatusPill({ mode }: { mode: NemoMode }) {
  const m = MODE[mode];
  return (
    <div role="status" aria-live="polite" className={`${m.bg} chip !px-4 !py-1.5 !text-base transition-colors`}>
      <m.Icon size={20} weight="bold" />
      <AnimatePresence mode="wait">
        <motion.span key={m.label} initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -8, opacity: 0 }}>
          {m.label}
        </motion.span>
      </AnimatePresence>
      {mode === 'speaking' && (
        <span className="flex items-end gap-0.5 h-4">
          {[0, 1, 2, 3].map((i) => (
            <motion.span
              key={i}
              className="w-1 bg-ink rounded-full"
              animate={{ height: ['30%', '100%', '45%', '80%', '30%'] }}
              transition={{ repeat: Infinity, duration: 0.9, delay: i * 0.12 }}
            />
          ))}
        </span>
      )}
      {mode === 'listening' && <motion.span className="w-2.5 h-2.5 rounded-full bg-ink" animate={{ opacity: [1, 0.2, 1] }} transition={{ repeat: Infinity, duration: 1.2 }} />}
    </div>
  );
}

// ---- Phase bar ---------------------------------------------------------------

const PHASE_LABEL: Record<Phase, string> = {
  FRAME: 'Frame',
  DIVERGE: 'Diverge',
  CLUSTER: 'Cluster',
  DEEPEN: 'Deepen',
  CHALLENGE: 'Challenge',
  CONVERGE: 'Converge',
  WRAPUP: 'Wrap-up',
};

export function PhaseBar({ phase, startedAt, method }: { phase: Phase; startedAt: number; method: MethodRun | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const idx = PHASES.indexOf(phase);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="panel !shadow-brut-sm flex items-center p-1 gap-1">
        {PHASES.map((p, i) => (
          <span
            key={p}
            className={`px-2.5 py-1 rounded-xl font-display font-bold text-xs transition-colors ${
              i === idx ? 'bg-brand text-white' : i < idx ? 'bg-sun-soft text-ink' : 'text-ink/50'
            }`}
          >
            {PHASE_LABEL[p]}
            {i === idx && <span className="ml-1.5 opacity-80 tabular-nums">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</span>}
          </span>
        ))}
      </div>
      <AnimatePresence>
        {method && (
          <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} className="chip bg-pink">
            <LightningIcon size={14} weight="fill" />
            {method.label}
            {method.target ? ` on #${method.target}` : ''}
            <span className="opacity-70 tabular-nums">
              {Math.min(method.step + 1, method.steps.length)}/{method.steps.length}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---- Pop-ups -----------------------------------------------------------------

const POP: Record<Popup['kind'], { bg: string; Icon: typeof SparkleIcon }> = {
  fact: { bg: 'bg-brand-soft', Icon: MagnifyingGlassIcon },
  challenge: { bg: 'bg-pink-soft', Icon: QuestionIcon },
  method: { bg: 'bg-sun-soft', Icon: LightningIcon },
  info: { bg: 'bg-white', Icon: SparkleIcon },
  warning: { bg: 'bg-pink-soft', Icon: WarningIcon },
  nemo: { bg: 'bg-white', Icon: SparkleIcon },
};

export function Popups({ popups }: { popups: Popup[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);
  // Newest first, so the latest pop-up is always on screen even on short displays.
  const visible = popups.filter((p) => !hidden.has(p.id) && now - p.createdAt < 60_000).slice(-3).reverse();
  return (
    <div className="flex flex-col gap-3 w-[340px] max-w-[calc(100vw-32px)]">
      <AnimatePresence initial={false}>
        {visible.map((p) => {
          const k = POP[p.kind];
          return (
            <motion.div
              key={p.id}
              layout
              initial={{ x: 60, opacity: 0, rotate: 2 }}
              animate={{ x: 0, opacity: 1, rotate: 0 }}
              exit={{ x: 60, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 24 }}
              className={`${k.bg} panel p-3.5 relative`}
            >
              <button aria-label="Dismiss" className="absolute top-2 right-2 opacity-60 hover:opacity-100 cursor-pointer" onClick={() => setHidden(new Set(hidden).add(p.id))}>
                <XIcon size={16} weight="bold" />
              </button>
              <div className="flex items-start gap-2 pr-5">
                <k.Icon size={20} weight="duotone" className="shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="font-display font-extrabold leading-tight">{p.title}</div>
                  {p.body && <p className="text-sm mt-1 leading-snug whitespace-pre-line line-clamp-4">{p.body}</p>}
                  {p.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {p.sources.slice(0, 3).map((s) => (
                        <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="chip !text-[11px] !py-0.5 !px-2 !shadow-none max-w-[180px] truncate">
                          <ArrowSquareOutIcon size={11} weight="bold" />
                          {s.title.replace(/ \(offline demo data\)$/, '')}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 text-[11px] font-bold opacity-60">
                    <span className="uppercase tracking-wide">Why now? </span>
                    {p.why}
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ---- Transcript ticker -------------------------------------------------------

export function Transcript({ lines, lang = 'en' }: { lines: TranscriptLine[]; lang?: Lang }) {
  const recent = lines.slice(-3);
  return (
    <div className="panel !shadow-brut-sm p-3 w-[360px] max-w-[calc(100vw-32px)] bg-white/95">
      <div className="text-[11px] font-display font-extrabold uppercase tracking-wider opacity-50 mb-1">{tr(lang, 'liveTranscript')}</div>
      <div className="flex flex-col gap-1">
        {recent.length === 0 && <div className="text-sm opacity-50">{tr(lang, 'transcriptEmpty')}</div>}
        {recent.map((l) => (
          <div key={l.id} className={`text-[13px] leading-snug line-clamp-2 ${l.final ? '' : 'opacity-50 italic'} ${l.speaker === 'nemo' ? 'text-brand font-bold' : ''}`}>
            <span className="font-display font-extrabold mr-1.5">{l.speaker === 'nemo' ? 'Nemo' : tr(lang, 'room')}</span>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Sub-agents --------------------------------------------------------------

const AGENT_BG: Record<string, string> = { blue: 'bg-brand-soft', pink: 'bg-pink-soft', yellow: 'bg-sun-soft', mint: 'bg-mint-soft', lilac: 'bg-lilac-soft' };

export function AgentPanel({ agents }: { agents: AgentStatus[] }) {
  const active = agents.filter((a) => a.state !== 'done' && a.state !== 'stopped' && a.state !== 'error');
  // Finished agents stay visible for a short while, then the panel folds away.
  const [lingering, setLingering] = useState(false);
  const activeCount = active.length;
  useEffect(() => {
    if (activeCount > 0) return setLingering(true);
    const t = setTimeout(() => setLingering(false), 20_000);
    return () => clearTimeout(t);
  }, [activeCount]);
  const recent = activeCount ? active.slice(0, 5) : lingering ? agents.slice(-3) : [];
  if (!recent.length) return null;
  return (
    <div className="panel p-3 w-[340px] max-w-[calc(100vw-32px)]">
      <div className="flex items-center gap-2 font-display font-extrabold text-sm mb-2">
        <MagnifyingGlassIcon size={16} weight="bold" />
        Research agents
        {active.length > 0 && <span className="chip !py-0 !px-2 !text-xs bg-brand text-white !shadow-none">{active.length} running</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        {recent.map((a) => (
          <div key={a.agentId} className={`${AGENT_BG[a.tone]} border-2 border-ink rounded-xl px-2.5 py-1.5 text-sm flex items-center gap-2`}>
            {a.state === 'done' ? (
              <CheckIcon size={14} weight="bold" />
            ) : a.state === 'stopped' || a.state === 'error' ? (
              <XIcon size={14} weight="bold" />
            ) : (
              <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }} className="inline-flex">
                <MagnifyingGlassIcon size={14} weight="bold" />
              </motion.span>
            )}
            <span className="font-display font-bold truncate">{a.label}</span>
            <span className="ml-auto text-xs opacity-70 whitespace-nowrap">
              {a.state === 'done' ? `${a.cards} cards` : `${a.state} · ${a.searches} searches`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Budget meter ------------------------------------------------------------

export function BudgetMeter({ tokens, max }: { tokens: number; max: number }) {
  return (
    <div className="chip" title="Interruption budget: Nemo spends tokens to interrupt unprompted, and earns them back over time.">
      <span className="text-xs">Interrupts</span>
      {Array.from({ length: max }).map((_, i) => (
        <span key={i} className={`w-3 h-3 rounded-full border-2 border-ink ${i < tokens ? 'bg-pink' : 'bg-white'}`} />
      ))}
    </div>
  );
}

// ---- Summary -----------------------------------------------------------------

export function SummaryModal({ summary, code, onClose, lang = 'en' }: { summary: SessionSummary; code: string; onClose: () => void; lang?: Lang }) {
  const t = (k: UiKey) => tr(lang, k);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 bg-ink/30 grid place-items-center p-4" onClick={onClose}>
      <motion.div
        initial={{ y: 30, scale: 0.95 }}
        animate={{ y: 0, scale: 1 }}
        className="panel !shadow-brut-lg bg-cream w-full max-w-3xl max-h-[88vh] overflow-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <NemoFace mode="listening" size={48} />
          <div className="min-w-0">
            <div className="text-xs font-display font-extrabold uppercase tracking-wider opacity-60">{t('summaryLabel')}</div>
            <h2 className="font-display font-extrabold text-2xl leading-tight">{summary.topic || 'Brainstorm'}</h2>
          </div>
          <button className="ml-auto opacity-60 hover:opacity-100 cursor-pointer" onClick={onClose} aria-label="Close">
            <XIcon size={22} weight="bold" />
          </button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {summary.topIdeas.map((item, i) => (
            <div key={i} className={`panel p-3 ${['bg-sun', 'bg-pink-soft', 'bg-brand-soft'][i % 3]}`}>
              <div className="font-display font-extrabold text-sm opacity-60">#{i + 1} {t('pick')} {item.num}</div>
              <div className="font-display font-extrabold leading-snug mt-1">{item.title}</div>
              {item.why && <div className="text-sm mt-1 opacity-80">{item.why}</div>}
            </div>
          ))}
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <List title={t('themes')} items={summary.clusters.map((c) => `${c.label}${c.gist ? ` — ${c.gist}` : ''}`)} />
          <List title={t('risks')} items={summary.risks} />
          <List title={t('openQuestions')} items={summary.openQuestions} />
          <List title={t('nextSteps')} items={summary.nextSteps} />
        </div>
        {summary.sources.length > 0 && <List title={t('sources')} items={summary.sources.map((s) => s.title)} links={summary.sources.map((s) => s.url)} />}
        <div className="mt-6 flex gap-3 flex-wrap">
          <a className="btn bg-sun" href={`/api/rooms/${code}/summary.md`}>
            <DownloadSimpleIcon size={18} weight="bold" />
            {t('download')}
          </a>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(summary.markdown)}>
            {t('copy')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function List({ title, items, links }: { title: string; items: string[]; links?: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <div className="font-display font-extrabold mb-1">{title}</div>
      <ul className="text-sm flex flex-col gap-1 list-disc pl-5">
        {items.map((it, i) => (
          <li key={i}>
            {links ? (
              <a className="text-brand font-bold underline" href={links[i]} target="_blank" rel="noreferrer">
                {it}
              </a>
            ) : (
              it
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Research toasts: every new sourced card pops up briefly ------------------

const TOAST_MS = 6000;

interface Toast {
  id: string;
  title: string;
  num?: number;
  source?: string;
  nemo: boolean;
}
const MAX_TOASTS = 1;

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function FactToasts({ cards, popups = [] }: { cards: Card[]; popups?: Popup[] }) {
  const seen = useRef<Set<string> | null>(null);
  const queue = useRef<Toast[]>([]);
  const shownKeys = useRef(new Set<string>());
  const [shown, setShown] = useState<{ card: Toast; until: number }[]>([]);

  // Queue fact cards that were not on the board when the page loaded.
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(cards.map((c) => c.id));
      return;
    }
    for (const c of cards) {
      if (seen.current.has(c.id)) continue;
      seen.current.add(c.id);
      // Only research Nemo ran for the room (agents' findings stay on the board, silently).
      if (c.kind !== 'fact' || c.ownerId !== 'nemo') continue;
      // No repeats on the same subject.
      const key = c.title.toLowerCase().replace(/[^a-zà-ÿ0-9 ]/g, '').split(' ').filter((w) => w.length > 3).slice(0, 3).join(' ');
      if (key && shownKeys.current.has(key)) continue;
      shownKeys.current.add(key);
      // Keep at most one waiting: the freshest wins.
      queue.current = [{ id: c.id, title: c.title, num: c.num, source: c.sources[0]?.url, nemo: false }];
    }
  }, [cards]);

  // Nemo's silent lines (it only speaks out loud when asked directly).
  const popupsReady = useRef(false);
  useEffect(() => {
    if (!popupsReady.current) {
      // Lines that were already there when the page loaded are not replayed.
      popupsReady.current = true;
      for (const p of popups) seen.current?.add(p.id);
      return;
    }
    for (const p of popups) {
      if (p.kind !== 'nemo' || seen.current?.has(p.id)) continue;
      seen.current?.add(p.id);
      queue.current = [{ id: p.id, title: p.title, nemo: true }];
    }
  }, [popups]);

  // Show them one after another, each for TOAST_MS.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setShown((cur) => {
        const alive = cur.filter((s) => s.until > now);
        while (alive.length < MAX_TOASTS && queue.current.length) {
          alive.push({ card: queue.current.shift()!, until: now + TOAST_MS });
        }
        return alive.length === cur.length && alive.every((a, i) => a === cur[i]) ? cur : alive;
      });
    }, 250);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex flex-col items-center gap-3 w-[min(620px,calc(100vw-32px))]">
      <AnimatePresence initial={false}>
        {[...shown].reverse().map(({ card }) => (
          <motion.div
            key={card.id}
            layout
            initial={{ y: -24, opacity: 0, scale: 0.94 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
            className="panel !shadow-brut-lg bg-white w-full px-4 py-3 overflow-hidden relative"
          >
            {/* One line, big and simple: the finding, then where it comes from. */}
            <div className="flex items-center gap-3 min-w-0">
              {card.nemo ? (
                <Mascot mode="listening" size={34} />
              ) : (
                <span className="shrink-0 grid place-items-center w-9 h-9 rounded-full bg-brand text-white border-2 border-ink">
                  <MagnifyingGlassIcon size={18} weight="bold" />
                </span>
              )}
              <span className="font-display font-extrabold text-xl leading-tight truncate">{card.title.replace(/ \(offline demo data\)/, '')}</span>
              {card.source && <span className="shrink-0 ml-auto text-xs font-bold text-brand">{host(card.source)}</span>}
            </div>
            <motion.div
              className="absolute left-0 bottom-0 h-1.5 bg-brand"
              initial={{ width: '100%' }}
              animate={{ width: '0%' }}
              transition={{ duration: TOAST_MS / 1000, ease: 'linear' }}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
