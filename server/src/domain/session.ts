import type { Lang, MethodRun, Phase } from '@nemo/shared';
import { PHASES } from '@nemo/shared';
import playbook from './playbook.json' with { type: 'json' };
import { normalize } from './text.ts';
import { METHOD_LABELS_FR, METHOD_STEPS_FR, t } from './i18n.ts';

// Session dynamics: the phase state machine, room signals and the method runner.
// All thresholds come from the facilitation playbook and are design heuristics.

const CONSENSUS = ["let's go with", 'lets go with', 'agreed', "that's the one", 'sounds good', 'i like', 'love that', "let's do", 'go for it',
  "d'accord", 'daccord', 'on part sur', 'on fait ca', 'top', 'carrement', 'grave', 'j aime bien', 'bonne idee', 'parfait'];
const NEGATIVE = ["won't work", 'wont work', 'too expensive', 'never', 'impossible', "doesn't work", 'bad idea', 'no way',
  'marchera pas', 'marche pas', 'trop cher', 'jamais', 'mauvaise idee', 'aucune chance'];

export interface SessionMetrics {
  phase: Phase;
  minutesInPhase: number;
  timeboxMin: number;
  cards: number;
  ideaRatePerMin: number; // last 3 min
  silenceS: number;
  consensusHits: number; // last 2 min
  negativityHits: number; // last 3 min
  questionRatio: number; // last 10 utterances
}

export interface PhaseSuggestion {
  to: Phase;
  reason: string;
}

export interface StallSignal {
  method: string;
  reason: string;
}

type MethodDef = { trigger: string; steps: string[]; exit: string; per_letter_s?: number; per_hat_min?: number; per_role_min?: number };
const METHODS = playbook.methods as Record<string, MethodDef>;
const STATES = playbook.states as Record<Phase, { timebox_min: number; methods?: string[] }>;

export const METHOD_LABELS: Record<string, string> = {
  HMW: 'How Might We',
  mind_map: 'Mind map',
  affinity_kj: 'Affinity clustering',
  scamper: 'SCAMPER',
  six_hats: 'Six Thinking Hats',
  reverse: 'Reverse brainstorming',
  '5_whys': '5 Whys',
  oral_brainwriting: 'Silent brainwriting',
  starbursting: 'Starbursting',
  round_robin: 'Round robin',
  worst_idea: 'Worst possible idea',
  analogies: 'Analogies',
  first_principles: 'First principles',
  premortem: 'Pre-mortem',
  dot_voting_voice: 'Dot voting',
  impact_effort: 'Impact / effort',
  disney: 'Disney method',
  lotus: 'Lotus blossom',
};

export function methodNames(): string[] {
  return Object.keys(METHODS);
}

export function resolveMethod(name: string): string | undefined {
  const n = normalize(name).replace(/ /g, '');
  // French names first.
  for (const [key, label] of Object.entries(METHOD_LABELS_FR)) {
    const l = normalize(label).replace(/ /g, '');
    if (n === l || n.includes(l)) return key;
  }
  if (n.includes('chapeau')) return 'six_hats';
  if (n.includes('pourquoi')) return '5_whys';
  if (n.includes('pire')) return 'worst_idea';
  if (n.includes('invers')) return 'reverse';
  if (n.includes('mortem')) return 'premortem';
  if (n.includes('cartementale')) return 'mind_map';
  if (n.includes('tourdetable')) return 'round_robin';
  for (const key of Object.keys(METHODS)) {
    const k = normalize(key).replace(/ /g, '');
    const label = normalize(METHOD_LABELS[key] ?? key).replace(/ /g, '');
    if (n === k || n === label || label.includes(n) || n.includes(label)) return key;
  }
  if (n.includes('hat')) return 'six_hats';
  if (n.includes('why')) return '5_whys';
  if (n.includes('vote') || n.includes('voting')) return 'dot_voting_voice';
  if (n.includes('worst')) return 'worst_idea';
  if (n.includes('premortem') || n.includes('mortem')) return 'premortem';
  if (n.includes('reverse') || n.includes('flip') || n.includes('inver')) return 'reverse';
  if (n.includes('howmightwe') || n === 'hmw') return 'HMW';
  return undefined;
}

export class Session {
  phase: Phase = 'FRAME';
  phaseStartedAt: number;
  method: MethodRun | null = null;
  private methodStepAt = 0;
  private ideaTimes: number[] = [];
  private consensusTimes: number[] = [];
  private negativeTimes: number[] = [];
  private recentQuestions: boolean[] = [];
  private lastSpeechAt: number;
  private stallMethodsUsed = new Set<string>();
  timeboxScale = 1; // < 1 compresses the agenda (demos)
  readonly methodsUsed: { name: string; at: number }[] = [];

  constructor(
    private now: () => number = Date.now,
    readonly lang: Lang = 'en',
  ) {
    this.phaseStartedAt = now();
    this.lastSpeechAt = now();
  }

  // ---- signals -----------------------------------------------------------

  recordUtterance(text: string) {
    const t = this.now();
    this.lastSpeechAt = t;
    const n = normalize(text);
    if (CONSENSUS.some((k) => n.includes(normalize(k)))) this.consensusTimes.push(t);
    if (NEGATIVE.some((k) => n.includes(normalize(k)))) this.negativeTimes.push(t);
    this.recentQuestions.push(/\?\s*$/.test(text.trim()) || /^(what|why|how|who|when|where|could|should|can|is|are|do|does)\b/.test(n));
    if (this.recentQuestions.length > 10) this.recentQuestions.shift();
  }

  recordIdeas(count: number) {
    const t = this.now();
    for (let i = 0; i < count; i++) this.ideaTimes.push(t);
  }

  metrics(cards: number): SessionMetrics {
    const t = this.now();
    const within = (arr: number[], ms: number) => arr.filter((x) => t - x <= ms).length;
    const elapsedMin = Math.max(1 / 60, Math.min(3, (t - this.phaseStartedAt) / 60_000));
    return {
      phase: this.phase,
      minutesInPhase: (t - this.phaseStartedAt) / 60_000,
      timeboxMin: this.timebox(this.phase),
      cards,
      ideaRatePerMin: within(this.ideaTimes, 180_000) / elapsedMin,
      silenceS: (t - this.lastSpeechAt) / 1000,
      consensusHits: within(this.consensusTimes, 120_000),
      negativityHits: within(this.negativeTimes, 180_000),
      questionRatio: this.recentQuestions.length ? this.recentQuestions.filter(Boolean).length / this.recentQuestions.length : 0,
    };
  }

  timebox(phase: Phase): number {
    return (STATES[phase]?.timebox_min ?? 5) * this.timeboxScale;
  }

  // ---- phases ------------------------------------------------------------

  setPhase(phase: Phase) {
    this.phase = phase;
    this.phaseStartedAt = this.now();
    this.stallMethodsUsed.clear();
  }

  nextPhase(): Phase {
    const i = PHASES.indexOf(this.phase);
    return PHASES[Math.min(PHASES.length - 1, i + 1)];
  }

  /** Deterministic transition proposal (the coach may also propose one). */
  suggestTransition(cards: number, hasTopic: boolean, votes: number): PhaseSuggestion | null {
    const m = this.metrics(cards);
    const overTime = m.minutesInPhase >= m.timeboxMin;
    switch (this.phase) {
      case 'FRAME':
        if (hasTopic && (overTime || cards >= 3)) return { to: 'DIVERGE', reason: 'The question is framed.' };
        return null;
      case 'DIVERGE':
        if (cards >= 20 && m.ideaRatePerMin < 1) return { to: 'CLUSTER', reason: `${cards} ideas and the flow is slowing down.` };
        if (overTime && cards >= 8) return { to: 'CLUSTER', reason: 'Diverge timebox reached.' };
        return null;
      case 'CONVERGE':
        if (votes >= 3 && overTime) return { to: 'WRAPUP', reason: 'Votes are in.' };
        return null;
      case 'WRAPUP':
        return null;
      default:
        if (overTime) return { to: this.nextPhase(), reason: `${this.phase.toLowerCase()} timebox reached.` };
        if (this.phase === 'CHALLENGE' && m.consensusHits >= 2) return { to: 'CONVERGE', reason: 'The group is converging.' };
        return null;
    }
  }

  /** Decision table: which unblocking method fits the current signals. */
  detectStall(cards: number): StallSignal | null {
    if (this.method) return null;
    const m = this.metrics(cards);
    const pick = (method: string, reason: string) => {
      if (this.stallMethodsUsed.has(method)) return null;
      this.stallMethodsUsed.add(method);
      return { method, reason };
    };
    if (this.phase === 'DIVERGE') {
      if (m.silenceS > 30) return pick('worst_idea', `Silence for ${Math.round(m.silenceS)}s.`);
      if (m.minutesInPhase > 3 && m.ideaRatePerMin < 1)
        return pick('reverse', `Only ${m.ideaRatePerMin.toFixed(1)} new ideas per minute.`) ?? pick('analogies', 'Ideas are drying up.');
      if (m.negativityHits >= 3) return pick('worst_idea', 'Lots of "that won\'t work" while diverging.');
    }

    if ((this.phase === 'DIVERGE' || this.phase === 'CLUSTER') && m.consensusHits >= 2 && m.minutesInPhase < 10)
      return pick('premortem', 'The group agreed very fast.');
    return null;
  }

  // ---- methods -----------------------------------------------------------

  startMethod(name: string, target?: number): MethodRun | null {
    const key = resolveMethod(name);
    if (!key) return null;
    const def = METHODS[key];
    const fr = this.lang === 'fr';
    const steps = fr ? (METHOD_STEPS_FR[key] ?? def.steps) : def.steps;
    this.method = {
      name: key,
      label: (fr ? METHOD_LABELS_FR[key] : METHOD_LABELS[key]) ?? key,
      step: 0,
      steps: steps.map((s) => (target ? s.replace(/#\{n\}/g, `#${target}`) : s.replace(/ ?#\{n\}/g, fr ? ' ça' : ' it'))),
      target,
      startedAt: this.now(),
    };
    this.methodStepAt = this.now();
    this.methodsUsed.push({ name: key, at: this.now() });
    return this.method;
  }

  /** Seconds each step lasts for the running method. */
  private stepSeconds(): number {
    if (!this.method) return 60;
    const def = METHODS[this.method.name];
    const base = def.per_letter_s ?? (def.per_hat_min ? def.per_hat_min * 60 : def.per_role_min ? def.per_role_min * 60 : 75);
    return Math.max(20, base * this.timeboxScale);
  }

  /** Advances the method when the step time is up. Returns the line to say, if any. */
  tickMethod(force = false): { line: string; done: boolean } | null {
    if (!this.method) return null;
    if (!force && (this.now() - this.methodStepAt) / 1000 < this.stepSeconds()) return null;
    this.method.step++;
    this.methodStepAt = this.now();
    if (this.method.step >= this.method.steps.length) {
      const label = this.method.label;
      this.method = null;
      return { line: t(this.lang, 'methodDone', { method: label }), done: true };
    }
    return { line: this.method.steps[this.method.step], done: false };
  }

  stopMethod() {
    this.method = null;
  }
}
