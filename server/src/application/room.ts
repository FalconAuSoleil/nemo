import PQueue from 'p-queue';
import type {
  AgentStatus,
  CanvasOp,
  Capabilities,
  Lang,
  NemoMode,
  Phase,
  Popup,
  RoomView,
  SessionSummary,
  Source,
  TranscriptLine,
} from '@nemo/shared';
import { NEMO_ID, PHASES } from '@nemo/shared';
import { Canvas, CanvasError } from '../domain/canvas.ts';
import { InterruptionBudget, type Proactivity } from '../domain/budget.ts';
import { Session } from '../domain/session.ts';
import { normalize, similarity, truncateWords } from '../domain/text.ts';
import { detectWakeWord } from '../domain/wakeword.ts';
import { languageRule, phaseName, t, type PhraseKey } from '../domain/i18n.ts';
import { Explorer } from './agents/explorer.ts';
import { ACT_TOOL, BRAIN_SYSTEM, COACH_SYSTEM, COACH_TOOL, FACT_TOOL, BRAINMASTER_RULES, REFOCUS_SYSTEM, RELAUNCH_SYSTEM, RELAUNCH_TOOL, RESEARCH_SYSTEM, SPEC_SYSTEM, FEATURES_TOOL, IDEATE_SYSTEM, IDEATE_TOOL, QUICK_IDEAS_SYSTEM, QUICK_IDEAS_TOOL, SUMMARY_SYSTEM, SUMMARY_TOOL } from './agents/prompts.ts';
import { Speaker, type SayPriority } from './agents/speaker.ts';
import type { Clock, LanguageModel, Logger, RoomPublisher, TextToSpeech, WebSearch } from './ports/index.ts';

export interface RoomDeps {
  llm: LanguageModel;
  search: WebSearch;
  tts: TextToSpeech | null;
  publisher: RoomPublisher;
  clock: Clock;
  log: Logger;
  capabilities: Capabilities;
  lang?: Lang;
  config?: Partial<RoomConfig>;
}

export interface RoomConfig {
  coachIntervalMs: number;
  timeboxScale: number;
  proactivity: Proactivity;
  breakpointSilenceMs: number;
  relaunchSilenceMs: number;
  /** brainmaster: directive, fast, challenges ideas; calm: discreet facilitator. */
  style: 'brainmaster' | 'calm';
  /** Silent start: no unprompted intervention during this time. */
  warmupMs: number;
}

const DEFAULTS: RoomConfig = { coachIntervalMs: 40_000, timeboxScale: 1, proactivity: 'balanced', breakpointSilenceMs: 1500, relaunchSilenceMs: 5_000, style: 'brainmaster', warmupMs: 180_000 };

interface ActArgs {
  intent?: string;
  add_ideas?: string[];
  idea_themes?: string[];
  nemo_ideas?: string[];
  nemo_idea_themes?: string[];
  focus?: string;
  spec_target?: string;
  ideate_count?: number;
  ideate_theme?: string;
  risks?: string[];
  topic?: string;
  ops_json?: string;
  research_query?: string;
  explore_theme?: string;
  method?: string;
  method_target?: number;
  phase?: string;
  reply?: string;
  reply_needs_web?: boolean;
  to_nemo?: boolean;
  speak?: boolean;
  off_track?: boolean;
  stop?: boolean;
}

export class Room {
  readonly lang: Lang;
  private langRule: string;
  readonly canvas: Canvas;
  readonly session: Session;
  readonly budget: InterruptionBudget;
  private explorer: Explorer;
  private speaker: Speaker;
  private cfg: RoomConfig;
  private transcript: TranscriptLine[] = [];
  private popups: Popup[] = [];
  private summary: SessionSummary | null = null;
  private pending: string[] = [];
  private brainBusy = false;
  private coachBusy = false;
  private lastCoachAt: number;
  private lastPartialAt = 0;
  private lastFinalAt = 0;
  private speakingUntil = 0;
  private mode: NemoMode = 'listening';
  private paused = false;
  private research = new PQueue({ concurrency: 3 });
  private researched = new Map<string, number>();
  private pendingPhase: { to: Phase; at: number } | null = null;
  private lastPhaseProposalAt = -Infinity;
  private lastRelaunchAt = -Infinity;
  private lastInterruptAt = -Infinity;
  /** Set when someone asks Nemo to answer out loud; the next answer is spoken. */
  private speakAllowedUntil = 0;
  private focus: RoomView['focus'] = null;
  private lastChallengeAt = -Infinity;
  private readonly brainmaster: boolean;
  private voiceActive = false;
  private lastVoiceAt = 0;
  private offTrackTimes: number[] = [];
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(
    readonly code: string,
    private deps: RoomDeps,
  ) {
    this.cfg = { ...DEFAULTS, ...deps.config };
    this.lang = deps.lang ?? 'en';
    this.langRule = languageRule(this.lang);
    const now = () => deps.clock.now();
    this.canvas = new Canvas(now);
    this.session = new Session(now, this.lang);
    this.session.timeboxScale = this.cfg.timeboxScale;
    this.brainmaster = this.cfg.style === 'brainmaster';
    // BrainMaster leads: a bigger budget that refills faster, and a faster coach.
    this.budget = this.brainmaster ? new InterruptionBudget(now, 4, 'active', 25_000) : new InterruptionBudget(now, 3, this.cfg.proactivity);
    if (this.brainmaster) this.cfg.coachIntervalMs = Math.min(this.cfg.coachIntervalMs, 12_000);
    this.lastCoachAt = now();
    this.explorer = new Explorer(deps.llm, deps.search, this.canvas, {
      apply: (ops) => this.publish(ops),
      status: () => this.patch({ agents: this.explorer.list() }),
      finished: (theme, summaries) => this.explorationDone(theme, summaries),
    }, deps.log, undefined, this.lang);
    this.speaker = new Speaker(code, deps.tts, deps.publisher, deps.clock, this.lang, {
      speakingChanged: (speaking, text) => {
        if (speaking && text) this.addLine(text, true, 'nemo');
        if (!speaking) this.speakingUntil = this.deps.clock.now() + 400;
        this.setMode(speaking ? 'speaking' : this.idleMode());
      },
      isBreakpoint: (priority) => this.isBreakpoint(priority),
    }, deps.log);
  }

  // ---- lifecycle ---------------------------------------------------------

  start(topic?: string) {
    if (topic) {
      this.publish(this.canvas.setTopic(topic));
      void this.prefetch('topic');
      // The topic is already framed: go straight to producing ideas.
      this.session.setPhase('DIVERGE');
    }
    this.startedAt = this.deps.clock.now();
    this.timer = setInterval(() => this.tick(), 1000);
    // No greeting: people start talking, Nemo listens.
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.explorer.cancelAll();
    this.speaker.clear();
  }

  view(): RoomView {
    return {
      code: this.code,
      lang: this.lang,
      canvas: this.canvas.state(),
      phase: this.session.phase,
      phaseStartedAt: this.session.phaseStartedAt,
      mode: this.mode,
      agents: this.explorer.list(),
      popups: this.popups,
      method: this.session.method,
      transcript: this.transcript.slice(-40),
      summary: this.summary,
      focus: this.focus,
      budget: { tokens: this.budget.available(), max: this.budget.max },
      capabilities: this.deps.capabilities,
    };
  }

  get version() {
    return this.canvas.version;
  }

  // ---- inbound use cases -------------------------------------------------

  handlePartial(text: string) {
    if (this.isEchoWindow()) return;
    this.lastPartialAt = this.deps.clock.now();
    this.patch({ transcript: [...this.transcript.slice(-39), { id: 'partial', text, final: false, speaker: 'room', at: this.lastPartialAt }] });
  }

  handleFinal(text: string) {
    const clean = text.trim();
    if (!clean || this.isEchoWindow() || looksLikeNoise(clean)) return;
    this.lastFinalAt = this.deps.clock.now();
    this.session.recordUtterance(clean);
    this.addLine(clean, true, 'room');
    if (this.pendingPhase && /\b(not yet|wait|no|hold on|stay|pas encore|attends|non|on reste)\b/i.test(clean)) {
      this.pendingPhase = null;
      this.sayIfAsked(this.t('staying'));
    }
    if (this.paused && !detectWakeWord(clean).addressed) return;
    // Explicit request for ideas: serve the prepared ones now, before the brain even answers.
    const ask = /\b(?:trouve|donne|propose|sors|g[ée]n[èe]re|find|give|suggest|come up with)\w*\b.*?\b(?:(\d+)\s+)?(?:id[ée]es?|ideas?|pistes?|suggestions?)\b(?:\s+(?:sur|pour|on|about|for)\s+(.+))?/i.exec(clean);
    if (ask) {
      this.lastQuickAt = this.deps.clock.now();
      void this.ideate(Math.min(8, Math.max(1, Number(ask[1] ?? 5))), (ask[2] ?? '').replace(/^(le|la|les|l['’]|the)\s*/i, '').replace(/[.?!]+$/, '').trim());
    }
    // Speed first: "search / explore / recherche…" puts 5-6 ideas on the board right away,
    // in parallel with the brain and the (slower) web research.
    if (/\b(search|explore[rsz]?|explor\w*|recherche[rsz]?|cherche[rsz]?|creuse[rsz]?|look (?:up|into)|dig into|investigate|fouille[rsz]?)\b/i.test(clean)) void this.quickIdeas(clean);
    // Instant zoom ("zoome sur le pricing", "montre le thème 2", "vue d'ensemble"): no wait, no reply.
    const zoom = /\b(?:zoom(?:e|er|ez)?|montre(?:z)?(?:[- ]moi|[- ]nous)?|affiche(?:z)?|va sur|allez sur|focus(?:e)?|show(?: me| us)?|go to|reviens sur|retourne sur)\b\s*(?:sur|on|to|in)?\s*(.*)$/i.exec(clean.replace(/^(hey |ok |hé |dis )?(nemo|nimo|neemo)[,.!]?\s*/i, ''));
    const overview = /\b(vue d['’ ]?ensemble|d[ée]zoom|zoom out|overview|big picture|tout le tableau)\b/i.test(clean);
    if ((zoom || overview) && this.focusOn(overview ? 'all' : (zoom?.[1] ?? '').replace(/[.?!]+$/, ''))) return;
    this.pending.push(clean);
    void this.runBrain();
  }

  handlePlayback(speaking: boolean) {
    this.speaker.playbackChanged(speaking);
  }

  /** Voice activity from the room mic: people are talking (or just stopped). */
  handleVoice(speaking: boolean) {
    this.voiceActive = speaking;
    this.lastVoiceAt = this.deps.clock.now();
  }

  /** Someone talked over Nemo: stop, forget what it was about to say, and give the floor back. */
  interrupt() {
    this.speaker.clear();
    this.speakingUntil = 0;
    this.lastInterruptAt = this.deps.clock.now();
    this.pendingPhase = null;
  }

  control(action: 'pause' | 'resume' | 'wrapup' | 'stop_agents' | 'next_phase') {
    switch (action) {
      case 'pause':
        this.paused = true;
        this.setMode('idle');
        break;
      case 'resume':
        this.paused = false;
        this.setMode('listening');
        break;
      case 'stop_agents':
        this.stopEverything();
        break;
      case 'next_phase':
        this.goToPhase(this.session.nextPhase(), this.t('movingOn'));
        break;
      case 'wrapup':
        this.goToPhase('WRAPUP', this.t('wrappingUp'));
        break;
    }
  }

  setProactivity(p: Proactivity) {
    this.budget.proactivity = p;
  }

  // ---- brain: one LLM decision per batch of utterances --------------------

  private async runBrain() {
    if (this.brainBusy) return;
    this.brainBusy = true;
    try {
      while (this.pending.length) {
        const batch = this.pending.splice(0);
        await this.think(batch);
      }
    } finally {
      this.brainBusy = false;
      this.setMode(this.idleMode());
    }
  }

  private lastAsked = '';

  private async think(batch: string[]) {
    this.lastAsked = batch.join(' ');
    const addressed = batch.some((u) => detectWakeWord(u).addressed);
    if (addressed) this.setMode('thinking');
    const history = this.transcript
      .filter((l) => l.final)
      .slice(-14, -batch.length || undefined)
      .map((l) => `${l.speaker === 'nemo' ? 'NEMO' : 'ROOM'}: ${l.text}`)
      .join('\n');
    const method = this.session.method;
    const user = [
      `PHASE: ${this.session.phase}${method ? ` | running method: ${method.label}${method.target ? ` on #${method.target}` : ''}, step "${method.steps[method.step]}"` : ''}`,
      `CANVAS:\n${this.canvas.compact()}`,
      `RECENT CONVERSATION:\n${history || '(start of session)'}`,
      `NEW UTTERANCES:\n${batch.map((b) => `ROOM: ${b}`).join('\n')}`,
      `NEMO ADDRESSED DIRECTLY: ${addressed ? 'yes' : 'no'}`,
      `If Nemo just proposed something (see last NEMO line) and the room agrees, act on it.`,
    ].join('\n\n');

    let args: ActArgs;
    try {
      const res = await this.deps.llm.chat({
        tier: 'fast',
        system: `${BRAIN_SYSTEM}\n\n${this.langRule}`,
        messages: [{ role: 'user', content: user }],
        tools: [ACT_TOOL],
        toolChoice: { name: 'act' },
        temperature: 0.3,
        maxTokens: 900,
      });
      args = (res.toolCalls[0]?.args ?? {}) as ActArgs;
      this.deps.log.info(
        `brain [${this.code}] "${batch.join(' | ').slice(0, 160)}" -> ${args.intent ?? '?'} ideas=${args.add_ideas?.length ?? 0} nemo_ideas=${args.nemo_ideas?.length ?? 0} ideate=${args.ideate_count ?? 0}:${args.ideate_theme ?? ""} ops=${String(args.ops_json ?? '').slice(0, 80)} topic=${args.topic ?? ''} reply="${(args.reply ?? '').slice(0, 80)}"`,
      );
    } catch (err) {
      this.deps.log.error('brain failed', String(err));
      if (addressed) this.sayIfAsked(this.t('lostThread'));
      return;
    }
    // A request to the assistant counts as addressed, even without its name.
    if (args.off_track) this.offTrackTimes.push(this.deps.clock.now());
    // A request to the assistant counts as addressed, even without its name.
    // Research Nemo infers on its own stays silent (card + pop-up only).
    this.applyAct(args, addressed || !!args.to_nemo || ['ask_nemo', 'explore_request', 'method_request'].includes(args.intent ?? ''));
  }

  private applyAct(a: ActArgs, addressed: boolean) {
    const ops: CanvasOp[] = [];
    const confirmations: string[] = [];
    if (a.speak) this.speakAllowedUntil = this.deps.clock.now() + 90_000;

    if (a.stop) {
      this.stopEverything();
      this.speakAllowedUntil = 0;
      return;
    }

    if (a.topic && a.topic.trim() && normalize(a.topic) !== normalize(this.canvas.getTopic())) {
      ops.push(...this.canvas.setTopic(a.topic));
      this.pools.delete('topic');
      void this.prefetch('topic');
    }

    const method = this.session.method;
    const methodCluster = method ? `${method.label}${method.target ? ` · #${method.target}` : ''}` : undefined;
    let added = 0;
    const ideaThemes = a.idea_themes ?? [];
    (a.add_ideas ?? []).forEach((raw, i) => {
      const [title, detail] = String(raw).split('::').map((x) => x.trim());
      if (!title) return;
      const cluster = methodCluster ?? this.themeFor(ideaThemes[i]);
      const r = this.canvas.addCard({ title: truncateWords(title, 10), body: detail || undefined, kind: 'idea', cluster });
      ops.push(...r.ops);
      if (!r.duplicateOf) {
        added++;
        if (method?.target) ops.push(...this.safe(() => this.canvas.link(method.target!, r.card.num, 'builds on')));
      }
    });
    // Ideas Nemo proposes because a human explicitly asked it to brainstorm.
    const nemoThemes = a.nemo_idea_themes ?? [];
    (a.nemo_ideas ?? []).slice(0, 8).forEach((raw, i) => {
      const [title, detail] = String(raw).split('::').map((x) => x.trim());
      if (!title) return;
      const cluster = methodCluster ?? this.themeFor(nemoThemes[i]);
      ops.push(...this.canvas.addCard({ title: truncateWords(title, 12), body: detail || undefined, kind: 'ai_idea', cluster }).ops);
    });
    for (const raw of a.risks ?? []) {
      ops.push(...this.canvas.addCard({ title: truncateWords(String(raw), 10), kind: 'risk', cluster: this.t('parking') }).ops);
    }
    if (added) this.session.recordIdeas(added);

    if (a.focus && a.focus.trim()) this.focusOn(a.focus.trim());
    if (a.spec_target && String(a.spec_target).trim()) void this.spec(String(a.spec_target).trim());
    const quickJustRan = this.deps.clock.now() - this.lastQuickAt < 8000;
    if (quickJustRan) {
      // The instant ideas already answered this utterance.
    } else if (a.ideate_count && a.ideate_count > 0 && !(a.nemo_ideas ?? []).length) void this.ideate(Math.min(8, Math.round(a.ideate_count)), String(a.ideate_theme ?? '').trim());
    else if (addressed && !(a.nemo_ideas ?? []).length && /\b(id[ée]es?|ideas?|suggestions?|pistes?)\b/i.test(this.lastAsked) && /\b(trouve|donne|propose|g[ée]n[èe]re|sors|find|give|suggest|come up)/i.test(this.lastAsked)) {
      // Safety net: an explicit request for ideas always gets the thought-through ideation.
      const n = Number(/\b(\d+)\b/.exec(this.lastAsked)?.[1] ?? 5);
      void this.ideate(Math.min(8, Math.max(1, n)), '');
    }

    const edits = parseOps(a.ops_json);
    for (const e of edits) {
      const r = this.applyEdit(e);
      ops.push(...r.ops);
      if (r.note) confirmations.push(r.note);
    }
    this.publish(ops);

    if (a.method) {
      const run = this.session.startMethod(a.method, a.method_target || undefined);
      if (run) {
        this.patch({ method: run });
        this.say(run.steps[0], 'reply'); // the group asked for this method
      }
    }

    // Only an explicit request moves the phase (models sometimes echo the current one).
    if (a.phase && (a.intent === 'phase_command' || addressed)) {
      const target = a.phase.toUpperCase() === 'NEXT' ? this.session.nextPhase() : (a.phase.toUpperCase() as Phase);
      if (PHASES.includes(target)) this.goToPhase(target);
    }

    // Exploring a shortlisted concept (or asking for its features) means its feature list, not web research.
    if (a.explore_theme && a.explore_theme.trim() && !a.spec_target) {
      const theme = a.explore_theme.trim();
      const concept = this.canvas.cardsList().find((c) => c.kind === 'decision' && similarity(c.title, theme) > 0.3);
      if (concept || /\b(features?|fonctionnalit|specs?)\b/i.test(theme)) {
        void this.spec(concept ? String(concept.num) : theme);
        a.explore_theme = '';
      }
    }
    if (a.explore_theme && a.explore_theme.trim()) {
      const num = /#?(\d+)/.exec(a.explore_theme)?.[1];
      const n = this.explorer.explore(a.explore_theme.trim(), num ? Number(num) : undefined);
      void n; // no announcement: the agents' lanes show up on the board
      this.patch({ agents: this.explorer.list() });
    }

    if (a.research_query && a.research_query.trim()) {
      const requested = addressed || !!a.reply_needs_web;
      this.lookUp(a.research_query.trim(), requested);
    }

    // Only real answers (never acknowledgements); spoken only if asked out loud, else shown.
    const reply = (a.reply ?? '').trim();
    if (reply && addressed && !a.reply_needs_web && !confirmations.length) this.say(reply, 'reply');
  }

  private applyEdit(e: Record<string, unknown>): { ops: CanvasOp[]; note?: string } {
    const nums = (Array.isArray(e.nums) ? e.nums : []).map(Number).filter(Number.isFinite);
    const num = Number(e.num);
    try {
      switch (e.op) {
        case 'merge':
          return { ops: this.canvas.merge(nums, e.title ? String(e.title) : undefined), note: this.t('merged', { nums: nums.join(this.lang === 'fr' ? ' et ' : ' and ') }) };
        case 'rename':
          return { ops: this.canvas.rename(num, String(e.title ?? '')), note: this.t('renamed', { num }) };
        case 'delete':
          return { ops: this.canvas.remove(num), note: this.t('removed', { num }) };
        case 'move':
          return { ops: this.canvas.move(nums, String(e.cluster ?? 'Unsorted')), note: this.t('moved', { cluster: String(e.cluster) }) };
        case 'group':
          return { ops: this.canvas.move(nums, String(e.label ?? 'Group')), note: this.t('grouped', { label: String(e.label) }) };
        case 'link':
          return { ops: this.canvas.link(Number(e.from), Number(e.to), e.label ? String(e.label) : undefined), note: this.t('linked') };
        case 'vote': {
          const ops = nums.flatMap((n) => this.canvas.vote(n, 1));
          return { ops, note: this.t('votes') };
        }
        case 'rename_cluster':
          return { ops: this.canvas.renameCluster(String(e.from ?? ''), String(e.to ?? '')), note: this.t('renamedCluster') };
        case 'shortlist': {
          // A dedicated block with only the concepts worth keeping.
          const label = truncateWords(String(e.label || this.t('bestIdeas')), 5);
          const { cluster, ops } = this.canvas.ensureCluster(label, NEMO_ID, 'yellow');
          const items = (Array.isArray(e.items) ? e.items : []).map(String).slice(0, 8);
          const existing = this.canvas.cardsList().filter((c) => c.clusterId === cluster.id);
          for (const raw of items) {
            const [title, pitch] = raw.split('::').map((x) => x.trim());
            // Never twice the same concept in the block (asking again refreshes, it does not duplicate).
            if (!title || existing.some((c) => similarity(c.title, title) > 0.5)) continue;
            ops.push(...this.canvas.addCard({ title: truncateWords(title, 8), body: pitch || undefined, kind: 'decision', cluster: cluster.id, allowDuplicate: true }).ops);
          }
          this.focusAt({ kind: 'cluster', ref: cluster.id });
          return { ops };
        }
        case 'expand':
          void this.expand(num);
          return { ops: [], note: this.t('breakingDown', { num }) };
        default:
          return { ops: [] };
      }
    } catch (err) {
      if (err instanceof CanvasError) {
        this.deps.log.warn('edit rejected', err.message);
        return { ops: [] };
      }
      throw err;
    }
  }

  private async expand(num: number) {
    const card = this.canvas.byNum(num);
    if (!card) return;
    try {
      const res = await this.deps.llm.chat({
        tier: 'fast',
        system: `You break one brainstorming idea down into concrete sub-ideas. Call "ideas" once with 3 or 4 card titles (max 8 words each).\n${this.langRule}`,
        messages: [{ role: 'user', content: `Topic: ${this.canvas.getTopic()}\nIdea #${card.num}: ${card.title}${card.body ? ` (${card.body})` : ''}` }],
        tools: [{ name: 'ideas', description: 'Sub-ideas', parameters: { type: 'object', properties: { ideas: { type: 'array', items: { type: 'string' } } }, required: ['ideas'] } }],
        toolChoice: { name: 'ideas' },
        temperature: 0.7,
        maxTokens: 300,
      });
      const ideas = ((res.toolCalls[0]?.args.ideas as string[]) ?? []).slice(0, 4);
      const cluster = this.canvas.clusterList().find((c) => c.id === card.clusterId)?.label;
      const ops: CanvasOp[] = [];
      for (const t of ideas) {
        const r = this.canvas.addCard({ title: truncateWords(t, 10), kind: 'ai_idea', cluster });
        ops.push(...r.ops);
        if (!r.duplicateOf) ops.push(...this.canvas.linkIds(card.id, r.card.id, 'part of'));
      }
      this.publish(ops);
    } catch (err) {
      this.deps.log.warn('expand failed', String(err));
    }
  }

  // ---- research lane (parallel, never blocks the voice loop) ------------

  private lookUp(query: string, requested: boolean, relatedNum?: number) {
    const key = normalize(query);
    const last = this.researched.get(key);
    if (last && this.deps.clock.now() - last < 5 * 60_000) return;
    this.researched.set(key, this.deps.clock.now());
    this.setMode(this.idleMode());
    void this.research.add(async () => {
      this.setMode(this.idleMode());
      try {
        const found = await this.deps.search.search(query, { depth: requested ? 'basic' : 'fast', maxResults: 5, language: this.lang });
        if (!found.results.length) {
          if (requested && this.deps.clock.now() < this.speakAllowedUntil) this.say(this.t('nothingFound'), 'reply');
          return;
        }
        const list = found.results.map((r, i) => `[${i}] ${r.title} (${r.url})\n${r.content.slice(0, 700)}`).join('\n\n');
        const res = await this.deps.llm.chat({
          tier: 'fast',
          system: `${RESEARCH_SYSTEM}\n${this.langRule}`,
          messages: [{ role: 'user', content: `Session topic: ${this.canvas.getTopic() || 'n/a'}\nQuery: ${query}\n\nResults:\n${list}` }],
          tools: [FACT_TOOL],
          toolChoice: { name: 'fact' },
          temperature: 0.2,
          maxTokens: 400,
        });
        const f = res.toolCalls[0]?.args as { title?: string; body?: string; verdict?: string; spoken?: string; source_indexes?: number[] } | undefined;
        if (!f?.title) return;
        const idx = (f.source_indexes ?? [0]).filter((i) => found.results[i]);
        const sources: Source[] = (idx.length ? idx : [0]).map((i) => ({ title: found.results[i].title, url: found.results[i].url }));
        const verdict = f.verdict && f.verdict !== 'info' ? ` (${f.verdict})` : '';
        const r = this.canvas.addCard({ title: truncateWords(f.title, 12), body: f.body, kind: 'fact', cluster: this.t('research'), sources });
        const ops = [...r.ops];
        if (relatedNum) ops.push(...this.safe(() => this.canvas.link(relatedNum, r.card.num, 'evidence')));
        this.publish(ops);
        const why = requested ? this.t('askedLookup') : this.t('claimCheck', { claim: truncateWords(query, 12) });
        if (requested) {
          this.pushPopup('fact', `#${r.card.num} ${f.title}${verdict}`, f.body ?? '', why, sources);
          // Spoken only if someone asked out loud; otherwise the card and its pop-up are the answer.
          if (this.deps.clock.now() < this.speakAllowedUntil) this.say(f.spoken || f.title, 'reply');
        } else if (this.budget.spend('popup')) {
          this.pushPopup('fact', `#${r.card.num} ${f.title}${verdict}`, f.body ?? '', why, sources);
          // The card and its pop-up already tell the room; no extra line.
        }
      } catch (err) {
        this.deps.log.warn('research failed', String(err));
        if (requested && this.deps.clock.now() < this.speakAllowedUntil) this.say(this.t('searchFailed'), 'reply');
      } finally {
        this.setMode(this.idleMode());
      }
    });
  }

  private explorationDone(theme: string, summaries: string[]) {
    const text = summaries.length === 1 ? summaries[0] : this.t('agentsDone', { n: summaries.length, theme: truncateWords(theme, 6), first: summaries[0] });
    this.pushPopup('info', this.t('explorationDone', { theme: truncateWords(theme, 6) }), summaries.join('\n'), this.t('askedExplore'), []);
    void text; // no announcement: the findings are on the board
    this.patch({ agents: this.explorer.list() });
  }

  // ---- coach: facilitation decisions on a slow cadence --------------------

  private async coach(force?: 'cluster') {
    if (this.coachBusy) return;
    this.coachBusy = true;
    this.lastCoachAt = this.deps.clock.now();
    try {
      const cards = this.canvas.cardCount();
      const humanIdeas = this.canvas.cardCount(['idea']);
      const m = this.session.metrics(cards);
      const stall = this.session.detectStall(cards);
      const unsorted = this.canvas.cardsList().filter((c) => c.clusterId === 'unsorted' && c.kind !== 'exploring').length;
      const signals = [
        `phase=${m.phase} (${m.minutesInPhase.toFixed(1)} of ${m.timeboxMin.toFixed(0)} min)`,
        `cards=${cards} human_ideas=${humanIdeas} unsorted=${unsorted}`,
        `idea_rate=${m.ideaRatePerMin.toFixed(1)}/min silence=${Math.round(m.silenceS)}s`,
        `consensus_hits=${m.consensusHits} negativity_hits=${m.negativityHits} question_ratio=${m.questionRatio.toFixed(2)}`,
        `interruption_budget=${this.budget.available()}/${this.budget.max}`,
        stall ? `detected_stall: ${stall.reason} -> suggested method ${stall.method}` : '',
        `coverage: risks=${this.canvas.cardCount(['risk'])} questions=${this.canvas.cardCount(['question'])} sourced_facts=${this.canvas.cardCount(['fact'])} nemo_ideas=${this.canvas.cardCount(['ai_idea'])} themes=${this.canvas.clusterList().length - 1} votes=${this.canvas.cardsList().reduce((n, c) => n + c.votes, 0)}`,
        `methods_used=${this.session.methodsUsed.map((x) => x.name).join(',') || 'none'}${this.session.methodsUsed.length ? ` (last ${Math.round((this.deps.clock.now() - this.session.methodsUsed[this.session.methodsUsed.length - 1].at) / 1000)}s ago)` : ''}`,
        `last_challenge=${Number.isFinite(this.lastChallengeAt) ? `${Math.round((this.deps.clock.now() - this.lastChallengeAt) / 1000)}s ago` : 'never'}`,
        force === 'cluster' ? 'The group just entered CLUSTER: cluster the cards now.' : '',
      ].filter(Boolean);
      const history = this.transcript.filter((l) => l.final).slice(-12).map((l) => `${l.speaker === 'nemo' ? 'NEMO' : 'ROOM'}: ${l.text}`).join('\n');
      const res = await this.deps.llm.chat({
        // BrainMaster needs speed: the fast model coaches.
        tier: this.brainmaster ? 'fast' : 'smart',
        system: `${COACH_SYSTEM}${this.brainmaster ? `\n\n${BRAINMASTER_RULES}` : ''}\n\n${this.langRule}`,
        messages: [{ role: 'user', content: `SIGNALS:\n${signals.join('\n')}\n\nCANVAS:\n${this.canvas.compact()}\n\nRECENT:\n${history}` }],
        tools: [COACH_TOOL],
        toolChoice: { name: 'coach' },
        temperature: 0.5,
        maxTokens: 900,
      });
      const c = (res.toolCalls[0]?.args ?? { action: 'none' }) as Record<string, any>;
      this.applyCoach(c, humanIdeas, force);
    } catch (err) {
      this.deps.log.warn('coach failed', String(err));
      const stall = this.session.detectStall(this.canvas.cardCount());
      if (stall) this.proposeMethod(stall.method, stall.reason);
    } finally {
      this.coachBusy = false;
    }
  }

  private applyCoach(c: Record<string, any>, humanIdeas: number, force?: 'cluster') {
    const why = String(c.why ?? '');
    const action = force === 'cluster' && c.action !== 'cluster' ? 'none' : String(c.action ?? 'none');
    switch (action) {
      case 'cluster': {
        // Diverge first, sort later: early clustering only when the board is crowded.
        const unsorted = this.canvas.cardsList().filter((k) => k.clusterId === 'unsorted' && k.kind !== 'exploring').length;
        const early = this.session.phase === 'FRAME' || this.session.phase === 'DIVERGE';
        if (!force && early && unsorted < 15 && this.deps.llm.name !== 'offline') return;
        const groups = parseOps(c.groups_json) as { label?: string; nums?: number[] }[];
        const ops: CanvasOp[] = [];
        for (const g of groups) {
          const nums = (g.nums ?? []).map(Number).filter((n) => this.canvas.byNum(n));
          if (g.label && nums.length) ops.push(...this.canvas.move(nums, truncateWords(g.label, 4)));
        }
        if (!ops.length) return;
        this.publish(ops);
        this.pushPopup('info', this.t('clustered'), this.t('clusteredBody', { n: groups.length }), why, []);
        if (c.say) this.say(String(c.say), 'proactive', 60_000);
        return;
      }
      case 'ai_ideas': {
        if (humanIdeas < 8 || !this.budget.spend('popup')) return;
        const ops: CanvasOp[] = [];
        for (const t of ((c.ideas as string[]) ?? []).slice(0, 3)) ops.push(...this.canvas.addCard({ title: truncateWords(t, 12), kind: 'ai_idea', cluster: this.t('sparks') }).ops);
        this.publish(ops);
        if (c.popup_title) this.pushPopup('info', c.popup_title, c.popup_body ?? '', why, []);
        return;
      }
      case 'challenge': {
        const text = String(c.say || c.popup_body || '');
        if (!text) return;
        // "From time to time": at most one challenge a minute.
        if (this.deps.clock.now() - this.lastChallengeAt < 60_000) return;
        this.lastChallengeAt = this.deps.clock.now();
        if (this.budget.spend('voice')) {
          this.pushPopup('challenge', c.popup_title || this.t('devil'), text, why, []);
          this.say(text, 'proactive');
        } else if (this.budget.spend('popup')) this.pushPopup('challenge', c.popup_title || this.t('devil'), text, why, []);
        return;
      }
      case 'blind_spot': {
        if (this.brainmaster) return; // no generic questions in BrainMaster
        if (!this.budget.spend('popup')) return;
        const q = String(c.popup_body || c.say || '');
        this.publish(this.canvas.addCard({ title: truncateWords(q, 12), kind: 'question', cluster: this.t('blindSpots') }).ops);
        this.pushPopup('info', c.popup_title || this.t('blindSpot'), q, why, []);
        return;
      }
      case 'method':
        // BrainMaster never launches a method on its own (methods only when the room asks).
        if (!c.method || this.brainmaster) return;
        this.proposeMethod(String(c.method), why, c.say);
        return;
      case 'phase': {
        const to = String(c.phase ?? '').toUpperCase() as Phase;
        if (!PHASES.includes(to) || to === this.session.phase) return;
        if (this.brainmaster && this.budget.spend('voice')) this.goToPhase(to, c.say || this.t('movingTo', { phase: phaseName(this.lang, to) }), false);
        else this.proposePhase(to, why, c.say);
        return;
      }
    }
  }

  /** BrainMaster: start the method instead of asking for permission. */
  private startMethodNow(method: string, target: number | undefined, why: string, line?: string) {
    const last = this.session.methodsUsed[this.session.methodsUsed.length - 1];
    if (this.session.method || (last && this.deps.clock.now() - last.at < 90_000)) return;
    if (!this.budget.spend('method')) return;
    const run = this.session.startMethod(method, target && this.canvas.byNum(target) ? target : undefined);
    if (!run) return;
    this.patch({ method: run });
    this.pushPopup('method', run.label, run.steps[0], why, []);
    this.say(line ? `${line} ${run.steps[0]}` : run.steps[0], 'method');
    this.deps.log.info(`brainmaster [${this.code}] starts ${run.label}: ${why}`);
  }

  private proposeMethod(method: string, why: string, line?: string) {
    if (!this.budget.spend('method')) return;
    const label = method.replace(/_/g, ' ');
    this.pushPopup('method', this.t('tryLabel', { method: label }), line || this.t('sayMethod', { method: label }), why, []);
    this.say(line || this.t('tryMethod', { method: label }), 'proactive');
  }

  private proposePhase(to: Phase, why: string, line?: string) {
    const now = this.deps.clock.now();
    if (this.pendingPhase || now - this.lastPhaseProposalAt < 150_000) return;
    if (!this.budget.spend('voice')) return;
    this.lastPhaseProposalAt = now;
    this.pendingPhase = { to, at: this.deps.clock.now() };
    this.pushPopup('info', this.t('nextLabel', { phase: phaseName(this.lang, to) }), line || this.t('stayHint'), why, []);
    this.say(line || this.t('proposePhase', { phase: phaseName(this.lang, to) }), 'proactive', 30_000);
  }

  /** `asked`: a human requested it (spoken reply); otherwise Nemo moves on silently. */
  private goToPhase(to: Phase, line?: string, asked = true) {
    if (to === this.session.phase) return;
    this.pendingPhase = null;
    this.session.setPhase(to);
    this.patch({ phase: to, phaseStartedAt: this.session.phaseStartedAt });
    if (line && asked) this.sayIfAsked(line);
    if (to === 'CLUSTER') void this.coach('cluster');
    if (to === 'WRAPUP') void this.wrapUp();
  }

  private async relaunch(silenceS: number, mode: 'silence' | 'refocus' = 'silence') {
    try {
      const recent = this.transcript.filter((l) => l.final).slice(-10).map((l) => `${l.speaker === 'nemo' ? 'NEMO' : 'ROOM'}: ${l.text}`).join('\n');
      const res = await this.deps.llm.chat({
        tier: 'fast',
        system: `${mode === 'refocus' ? REFOCUS_SYSTEM : RELAUNCH_SYSTEM}\n\n${this.langRule}`,
        messages: [
          {
            role: 'user',
            content: `${mode === 'refocus' ? 'The discussion is scattering.' : `Silence for ${silenceS}s.`} PHASE: ${this.session.phase}\n\nCANVAS:\n${this.canvas.compact()}\n\nRECENT:\n${recent || '(nothing yet)'}`,
          },
        ],
        tools: [RELAUNCH_TOOL],
        toolChoice: { name: 'relaunch' },
        temperature: 0.8,
        maxTokens: 400,
      });
      const r = (res.toolCalls[0]?.args ?? {}) as { say?: string; ideas?: string[] };
      const ops: CanvasOp[] = [];
      for (const idea of (r.ideas ?? []).slice(0, 3)) ops.push(...this.canvas.addCard({ title: truncateWords(String(idea), 12), kind: 'ai_idea', cluster: this.t('sparks') }).ops);
      this.publish(ops);
      if (r.say) this.say(String(r.say), 'proactive', 30_000);
      this.deps.log.info(`${mode} [${this.code}]${mode === 'silence' ? ` after ${silenceS}s` : ''}: "${r.say ?? ''}" +${ops.length ? (r.ideas ?? []).length : 0} ideas`);
    } catch (err) {
      this.deps.log.warn('relaunch failed', String(err));
    }
  }

  // ---- wrap-up -----------------------------------------------------------

  private async wrapUp() {
    this.setMode('thinking');
    try {
      const transcript = this.transcript.filter((l) => l.final).slice(-60).map((l) => `${l.speaker}: ${l.text}`).join('\n');
      const res = await this.deps.llm.chat({
        tier: 'smart',
        system: `${SUMMARY_SYSTEM}\n${this.langRule}`,
        messages: [{ role: 'user', content: `CANVAS:\n${this.canvas.compact(200)}\n\nTRANSCRIPT (end):\n${transcript}` }],
        tools: [SUMMARY_TOOL],
        toolChoice: { name: 'summary' },
        temperature: 0.4,
        maxTokens: 1400,
      });
      const s = (res.toolCalls[0]?.args ?? {}) as Record<string, any>;
      this.summary = buildSummary(this.canvas, s, this.lang);
      this.patch({ summary: this.summary });
      this.sayIfAsked(String(s.spoken || this.t('summaryOnScreen')));
    } catch (err) {
      this.deps.log.error('summary failed', String(err));
      this.summary = buildSummary(this.canvas, {}, this.lang);
      this.patch({ summary: this.summary });
    } finally {
      this.setMode(this.idleMode());
    }
  }

  // ---- clock -------------------------------------------------------------

  private tick() {
    const now = this.deps.clock.now();
    this.speaker.pump();
    this.keepPoolsWarm();
    if (this.paused || this.session.phase === 'WRAPUP') return;

    const step = this.session.tickMethod();
    if (step) {
      this.patch({ method: this.session.method });
      this.say(step.line, 'method');
    }

    if (this.pendingPhase && now - this.pendingPhase.at > 9000 && !this.speaker.speaking) {
      const to = this.pendingPhase.to;
      this.pendingPhase = null;
      this.goToPhase(to, this.t('movingTo', { phase: phaseName(this.lang, to) }), false);
      return;
    }

    const cards = this.canvas.cardCount();
    const votes = this.canvas.cardsList().reduce((s, c) => s + c.votes, 0);
    const suggestion = this.session.suggestTransition(cards, !!this.canvas.getTopic(), votes);
    if (suggestion && !this.pendingPhase && this.session.phase === 'FRAME' && suggestion.to === 'DIVERGE') {
      this.goToPhase('DIVERGE', undefined, false);
      this.pushPopup('info', this.t('divergeTitle'), this.t('divergeBody'), suggestion.reason, []);
    } else if (suggestion && !this.pendingPhase && !this.inWarmup() && this.budget.canSpend('voice')) {
      this.proposePhase(suggestion.to, suggestion.reason);
    }

    // Warm-up: let people talk. Nemo only captures ideas and answers when asked.
    if (this.inWarmup()) {
      this.patch({ budget: { tokens: this.budget.available(), max: this.budget.max } }, true);
      return;
    }

    // Scattered discussion: recentre on the topic, within the interruption budget.
    this.offTrackTimes = this.offTrackTimes.filter((t) => now - t < 90_000);
    if (
      this.offTrackTimes.length >= 2 &&
      now - this.lastRelaunchAt > 45_000 &&
      !this.session.method &&
      !this.brainBusy &&
      !this.speaker.speaking &&
      this.isBreakpoint() &&
      this.budget.spend('voice')
    ) {
      this.lastRelaunchAt = now;
      this.offTrackTimes = [];
      void this.relaunch(0, 'refocus');
    }

    // Silence: relaunch the room (topic-aware), within the interruption budget.
    const silenceMs = now - Math.max(this.lastFinalAt, this.lastVoiceAt, this.startedAt, this.lastInterruptAt + 15_000);
    if (
      !this.voiceActive &&
      silenceMs > this.cfg.relaunchSilenceMs &&
      now - this.lastRelaunchAt > Math.max(45_000, this.cfg.relaunchSilenceMs * 2) &&
      ['FRAME', 'DIVERGE', 'DEEPEN'].includes(this.session.phase) &&
      !this.session.method &&
      !this.brainBusy &&
      !this.speaker.speaking &&
      this.budget.spend('voice')
    ) {
      this.lastRelaunchAt = now;
      void this.relaunch(Math.round(silenceMs / 1000));
    }

    if (now - this.lastCoachAt > this.cfg.coachIntervalMs && !this.brainBusy && !this.speaker.speaking && this.session.phase !== 'FRAME') {
      void this.coach();
    }
    this.patch({ budget: { tokens: this.budget.available(), max: this.budget.max } }, true);
  }

  // ---- helpers -----------------------------------------------------------

  private stopEverything() {
    this.explorer.cancelAll();
    this.research.clear();
    this.session.stopMethod();
    this.speaker.clear();
    this.patch({ method: null, agents: this.explorer.list() });
  }

  private t(key: PhraseKey, params?: Record<string, string | number>) {
    return t(this.lang, key, params);
  }

  /** Nemo only speaks out loud when someone asked it directly; everything else is shown silently. */
  private say(text: string, priority: SayPriority, ttlMs?: number) {
    // Out loud only when a human explicitly asked Nemo to answer orally.
    if (priority === 'reply' && this.deps.clock.now() < this.speakAllowedUntil) {
      this.speakAllowedUntil = 0;
      return this.speaker.say(text, priority, ttlMs);
    }
    this.whisper(text);
  }

  /** Spoken only if someone asked Nemo to answer out loud; otherwise nothing at all. */
  private sayIfAsked(text: string) {
    if (this.deps.clock.now() < this.speakAllowedUntil) this.say(text, 'reply');
  }

  private whisper(text: string) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    this.addLine(clean, true, 'nemo');
    this.pushPopup('nemo', clean, '', '', []);
  }

  /** At most this many idea themes, so each one stays a distinct, readable block. */
  private static readonly MAX_THEMES = 6;

  /** Cluster for an idea: reuse a close theme, create a new one only while there are few. */
  private themeFor(label?: string): string | undefined {
    const clean = label ? truncateWords(label.replace(/[.:]+$/, ''), 4) : '';
    if (!clean) return undefined;
    const close = this.canvas.findCluster(clean);
    if (close) return close.id;
    const reserved = new Set(['unsorted', normalize(this.t('parking')), normalize(this.t('research')), normalize(this.t('sparks')), normalize(this.t('blindSpots'))]);
    const ideaClusters = new Set(this.canvas.cardsList().filter((c) => c.kind === 'idea' || c.kind === 'ai_idea').map((c) => c.clusterId));
    const themes = this.canvas.clusterList().filter((c) => c.ownerId === 'nemo' && c.id !== 'unsorted' && ideaClusters.has(c.id) && !reserved.has(normalize(c.label)));
    return themes.length < Room.MAX_THEMES ? clean : undefined;
  }

  /** Numbered themes, in the order screens show them (same rule as the client's theme bar). */
  private themes() {
    const used = new Set(this.canvas.cardsList().map((c) => c.clusterId));
    return this.canvas
      .clusterList()
      .filter((c) => c.ownerId === 'nemo' && c.id !== 'unsorted' && used.has(c.id))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * "Show me pricing" / "thème 3" / "la 12" / "celui sur le compost" / "vue d'ensemble":
   * tells every screen where to look. Returns true when it understood the target.
   */
  focusOn(target: string): boolean {
    let n = normalize(target);
    for (let prev = ''; prev !== n; ) {
      prev = n;
      n = n.replace(/^(sur|on|to|the|le|la|les|l|du|des|de|au|aux|un|une|celui|celle|ceux|qui|parle|about|theme|cluster|groupe|bloc|block|sujet|topic)\b\s*/, '').trim();
    }
    const at = this.deps.clock.now();
    let focus: RoomView['focus'] = null;
    // "zoom on each theme" / "un par un": a guided tour, 5 s per theme.
    if (/\b(chacun|chaque|tous les|toutes les|each|every|one by one|un par un|une par une|tour|visite|passe en revue)\b/.test(normalize(target)) && this.themes().length) focus = { kind: 'tour', at };
    else if (/^(all|everything|overview|whole|tout|vue|ensemble|global|dezoom|zoom out)/.test(n) || /vue d ensemble|tout le tableau|big picture/.test(normalize(target))) focus = { kind: 'all', at };
    else if (/research|recherche|source|agent|trouvaille|finding/.test(n)) focus = { kind: 'research', at };
    else {
      const themeNum = /(?:theme|thème|cluster|groupe|bloc|block|sujet)\s*(?:n(?:um(?:ero)?)?\s*)?(\d+)/.exec(normalize(target))?.[1];
      const cardNum = /^(?:carte|card|idee|idea|post it|numero|number|n)?\s*#?(\d+)$/.exec(n)?.[1];
      const themes = this.themes();
      if (themeNum && themes[Number(themeNum) - 1]) focus = { kind: 'cluster', ref: themes[Number(themeNum) - 1].id, at };
      else if (cardNum && this.canvas.byNum(Number(cardNum))) focus = { kind: 'card', ref: this.canvas.byNum(Number(cardNum))!.id, at };
      else {
        const cl = n ? this.canvas.findCluster(n) : undefined;
        if (cl) focus = { kind: 'cluster', ref: cl.id, at };
        else if (n) {
          // "the one about compost": the theme of the best-matching idea, or of a matching label word.
          const words = new Set(n.split(' ').filter((w) => w.length > 3).map((w) => w.slice(0, 5)));
          let best: { id: string; score: number } | undefined;
          for (const c of this.canvas.cardsList()) {
            if (c.kind === 'exploring') continue;
            const label = this.canvas.clusterList().find((x) => x.id === c.clusterId)?.label ?? '';
            const hay = normalize(`${c.title} ${label}`).split(' ').map((w) => w.slice(0, 5));
            const score = hay.filter((w) => words.has(w)).length + similarity(c.title, n);
            if (score >= 1 && (!best || score > best.score)) best = { id: c.clusterId, score };
          }
          if (best) focus = best.id === 'unsorted' ? { kind: 'all', at } : { kind: 'cluster', ref: best.id, at };
        }
      }
    }
    if (focus) this.patch({ focus });
    return !!focus;
  }

  private focusAt(f: { kind: 'cluster' | 'card' | 'all' | 'research'; ref?: string }) {
    this.patch({ focus: { ...f, at: this.deps.clock.now() } });
  }

  /** "Explore Network Relationship Manager": its features in their own block, linked to the concept. */
  private async spec(target: string) {
    const cleaned = target
      .replace(/^(explore[rz]?|explorer|explore|d[ée]taille[rz]?|spec(?:ifie)?|creuse[rz]?)\s+/i, '')
      .replace(/^(le|la|les|l['’]|un|une|the|a)\s*/i, '')
      .replace(/^(domaine|space|concept|id[ée]e|projet|project)\s+(des?|du|de la|of)?\s*/i, '')
      .replace(/[.?!]+$/, '')
      .trim();
    const num = /^#?(\d+)$/.exec(cleaned)?.[1];
    let concept = num ? this.canvas.byNum(Number(num)) : await this.resolveConcept(cleaned);
    const name = concept?.title ?? truncateWords(cleaned || target, 6);
    try {
      const res = await this.deps.llm.chat({
        tier: 'fast',
        system: `${SPEC_SYSTEM}\n${this.langRule}`,
        messages: [{ role: 'user', content: `Session topic: ${this.canvas.getTopic() || 'n/a'}\nConcept: ${name}${concept?.body ? ` (${concept.body})` : ''}\n\nCanvas (for context):\n${this.canvas.compact(40)}` }],
        tools: [FEATURES_TOOL],
        toolChoice: { name: 'features' },
        temperature: 0.6,
        maxTokens: 900,
      });
      const features = ((res.toolCalls[0]?.args.features as string[]) ?? []).slice(0, 10);
      if (!features.length) return;
      const ops: CanvasOp[] = [];
      if (!concept) {
        const r = this.canvas.addCard({ title: name, kind: 'decision', cluster: this.t('bestIdeas') });
        ops.push(...r.ops);
        concept = r.card;
      }
      const lane = this.canvas.ensureCluster(this.t('featuresOf', { concept: truncateWords(name, 4) }), NEMO_ID, 'mint');
      ops.push(...lane.ops);
      for (const f of features) {
        const [title, detail] = String(f).split('::').map((x) => x.trim());
        if (!title) continue;
        const r = this.canvas.addCard({ title: truncateWords(title, 8), body: detail || undefined, kind: 'feature', cluster: lane.cluster.id, allowDuplicate: true });
        ops.push(...r.ops, ...this.canvas.linkIds(concept.id, r.card.id));
      }
      this.publish(ops);
      this.focusAt({ kind: 'cluster', ref: lane.cluster.id });
      this.deps.log.info(`spec [${this.code}] ${name}: ${features.length} features`);
    } catch (err) {
      this.deps.log.warn('spec failed', String(err));
    }
  }

  private lastQuickAt = -Infinity;

  // ---- idea pools: prepared silently in the background, shown only when asked ----

  private pools = new Map<string, { title: string; detail?: string; theme?: string }[]>();
  private prefetching = new Set<string>();
  private lastPrefetchAt = 0;

  /** Prepares ideas for the topic ('topic') or a theme (cluster id), without showing them. */
  private async prefetch(key: string, themeLabel?: string) {
    if (this.prefetching.has(key) || !this.canvas.getTopic()) return;
    this.prefetching.add(key);
    try {
      const res = await this.deps.llm.chat({
        tier: themeLabel ? 'fast' : 'smart',
        system: `${IDEATE_SYSTEM}\n${this.langRule}`,
        messages: [
          {
            role: 'user',
            content: `Session topic: ${this.canvas.getTopic()}\nRequested: ${themeLabel ? 6 : 8} ideas${themeLabel ? ` on "${themeLabel}"` : ' on the session topic'}\n\nCANVAS:\n${this.canvas.compact(80)}`,
          },
        ],
        tools: [IDEATE_TOOL],
        toolChoice: { name: 'ideate' },
        temperature: 0.8,
        maxTokens: 1500,
      });
      const r = (res.toolCalls[0]?.args ?? {}) as { ideas?: string[]; themes?: string[] };
      const items = (r.ideas ?? []).map((raw, i) => {
        const [title, detail] = String(raw).split('::').map((x) => x.trim());
        return { title, detail: detail || undefined, theme: themeLabel ?? r.themes?.[i] };
      }).filter((x) => x.title);
      this.pools.set(key, [...(this.pools.get(key) ?? []), ...items].slice(-16));
      this.deps.log.info(`prefetch [${this.code}] ${items.length} ideas ready for ${themeLabel ? `"${themeLabel}"` : 'the topic'}`);
    } catch (err) {
      this.deps.log.warn('prefetch failed', String(err));
    } finally {
      this.prefetching.delete(key);
    }
  }

  /** Takes up to n prepared ideas that are not already on the board. */
  private takeFromPool(key: string, n: number) {
    const pool = this.pools.get(key) ?? [];
    const onBoard = this.canvas.cardsList().map((c) => c.title);
    const fresh = pool.filter((p) => !onBoard.some((t) => similarity(t, p.title) > 0.5));
    const taken = fresh.slice(0, n);
    this.pools.set(key, fresh.slice(n));
    return taken;
  }

  /** Background: keep a pool ready for the topic and every theme on the board. */
  private keepPoolsWarm() {
    const now = this.deps.clock.now();
    if (now - this.lastPrefetchAt < 8000 || this.prefetching.size >= 2 || !this.canvas.getTopic()) return;
    const want: [string, string | undefined][] = [];
    if ((this.pools.get('topic')?.length ?? 0) < 4) want.push(['topic', undefined]);
    const reserved = new Set([this.t('parking'), this.t('research'), this.t('sparks'), this.t('blindSpots'), this.t('bestIdeas')].map(normalize));
    for (const c of this.themes()) if (!reserved.has(normalize(c.label)) && (this.pools.get(c.id)?.length ?? 0) < 3 && this.canvas.cardsList().some((k) => k.clusterId === c.id && (k.kind === 'idea' || k.kind === 'ai_idea'))) want.push([c.id, c.label]);
    const next = want.find(([k]) => !this.prefetching.has(k));
    if (!next) return;
    this.lastPrefetchAt = now;
    void this.prefetch(next[0], next[1]);
  }

  /** Instant ideas about what was just said (one fast call, no web). */
  private async quickIdeas(utterance: string) {
    const now = this.deps.clock.now();
    if (now - this.lastQuickAt < 4000) return;
    this.lastQuickAt = now;
    try {
      const res = await this.deps.llm.chat({
        tier: 'fast',
        system: `${QUICK_IDEAS_SYSTEM}\n${this.langRule}`,
        messages: [{ role: 'user', content: `Session topic: ${this.canvas.getTopic() || 'n/a'}\nThey just said: "${utterance}"\n\nCanvas themes and ideas:\n${this.canvas.compact(50)}` }],
        tools: [QUICK_IDEAS_TOOL],
        toolChoice: { name: 'quick' },
        temperature: 0.7,
        maxTokens: 600,
      });
      const r = (res.toolCalls[0]?.args ?? {}) as { theme?: string; ideas?: string[] };
      const cluster = this.themeFor(r.theme);
      const ops: CanvasOp[] = [];
      let firstCluster: string | undefined;
      for (const raw of (r.ideas ?? []).slice(0, 6)) {
        const [title, detail] = String(raw).split('::').map((x) => x.trim());
        if (!title) continue;
        const added = this.canvas.addCard({ title: truncateWords(title, 10), body: detail || undefined, kind: 'ai_idea', cluster });
        ops.push(...added.ops);
        firstCluster ??= added.card.clusterId;
      }
      this.publish(ops);
      if (firstCluster) this.focusAt({ kind: 'cluster', ref: firstCluster });
      this.deps.log.info(`quick [${this.code}] ${ops.length ? (r.ideas ?? []).length : 0} ideas in "${r.theme ?? ''}" (${this.deps.clock.now() - now}ms)`);
    } catch (err) {
      this.deps.log.warn('quick ideas failed', String(err));
    }
  }

  /** "Find 5 ideas on X": a dedicated, thought-through ideation step (analysis first, one idea per angle). */
  private async ideate(count: number, theme: string) {
    const cluster = theme ? this.canvas.findCluster(theme) : undefined;
    const started = this.deps.clock.now();
    // Prepared ideas first: they show up instantly.
    const pooled = this.takeFromPool(cluster ? cluster.id : 'topic', count);
    if (pooled.length >= Math.min(count, 3)) {
      const ops: CanvasOp[] = [];
      let first: string | undefined;
      for (const p of pooled) {
        const added = this.canvas.addCard({ title: truncateWords(p.title, 10), body: p.detail, kind: 'ai_idea', cluster: cluster?.id ?? this.themeFor(p.theme) });
        ops.push(...added.ops);
        first ??= added.card.clusterId;
      }
      this.publish(ops);
      if (first) this.focusAt({ kind: 'cluster', ref: cluster?.id ?? first });
      this.deps.log.info(`ideate [${this.code}] ${pooled.length} prepared ideas shown instantly${cluster ? ` in "${cluster.label}"` : ''}`);
      this.lastPrefetchAt = 0; // refill soon
      return;
    }
    try {
      const res = await this.deps.llm.chat({
        tier: 'smart',
        system: `${IDEATE_SYSTEM}\n${this.langRule}`,
        messages: [
          {
            role: 'user',
            content: `Session topic: ${this.canvas.getTopic() || 'n/a'}\nRequested: ${count} ideas${theme ? ` on "${theme}"` : ' on the session topic'}\n\nCANVAS:\n${this.canvas.compact(120)}\n\nRECENT CONVERSATION:\n${this.transcript.filter((l) => l.final).slice(-8).map((l) => `${l.speaker === 'nemo' ? 'NEMO' : 'ROOM'}: ${l.text}`).join('\n')}`,
          },
        ],
        tools: [IDEATE_TOOL],
        toolChoice: { name: 'ideate' },
        temperature: 0.8,
        maxTokens: 1600,
      });
      const r = (res.toolCalls[0]?.args ?? {}) as { analysis?: string; ideas?: string[]; themes?: string[] };
      const ops: CanvasOp[] = [];
      (r.ideas ?? []).slice(0, count).forEach((raw, i) => {
        const [title, detail] = String(raw).split('::').map((x) => x.trim());
        if (!title) return;
        const target = cluster?.id ?? this.themeFor(r.themes?.[i] || theme);
        ops.push(...this.canvas.addCard({ title: truncateWords(title, 10), body: detail || undefined, kind: 'ai_idea', cluster: target }).ops);
      });
      this.publish(ops);
      const placed = this.canvas.cardsList().filter((c) => c.kind === 'ai_idea' && c.createdAt >= started);
      if (placed.length) this.focusAt(cluster ? { kind: 'cluster', ref: cluster.id } : { kind: 'cluster', ref: placed[0].clusterId });
      this.deps.log.info(`ideate [${this.code}] ${count} on "${theme || 'topic'}" (${this.deps.clock.now() - started}ms): ${String(r.analysis ?? '').slice(0, 160)}`);
    } catch (err) {
      this.deps.log.warn('ideate failed', String(err));
    }
  }

  /** Which card does "Network Relationship Manager" mean? Words first, then a quick model call (cross-language). */
  private async resolveConcept(target: string) {
    const candidates = this.canvas.cardsList().filter((c) => c.kind === 'decision' || c.kind === 'idea' || c.kind === 'ai_idea');
    if (!candidates.length) return undefined;
    const ranked = candidates.map((c) => ({ c, s: similarity(c.title, target) + (c.kind === 'decision' ? 0.05 : 0) })).sort((a, b) => b.s - a.s);
    if (ranked[0].s > 0.45) return ranked[0].c;
    try {
      const list = candidates
        .sort((a, b) => (a.kind === 'decision' ? -1 : 0) - (b.kind === 'decision' ? -1 : 0))
        .slice(0, 40)
        .map((c) => `#${c.num} ${c.title}${c.body ? ` (${c.body.slice(0, 80)})` : ''}`)
        .join('\n');
      const res = await this.deps.llm.chat({
        tier: 'fast',
        system: 'Pick the card the group refers to (it may be named differently or in another language). Call "pick" with its number, or 0 if none fits.',
        messages: [{ role: 'user', content: `They said: "${target}"\n\nCards:\n${list}` }],
        tools: [{ name: 'pick', description: 'The referred card.', parameters: { type: 'object', properties: { num: { type: 'integer' } }, required: ['num'] } }],
        toolChoice: { name: 'pick' },
        temperature: 0,
        maxTokens: 50,
      });
      const n = Number(res.toolCalls[0]?.args.num);
      return n ? this.canvas.byNum(n) : undefined;
    } catch {
      return ranked[0].s > 0.25 ? ranked[0].c : undefined;
    }
  }

  /** The first minutes belong to the room: no unprompted intervention at all. */
  private inWarmup(): boolean {
    return this.deps.clock.now() - this.startedAt < this.cfg.warmupMs;
  }

  /** Quiet enough to speak? Replies need a short pause, unprompted lines a longer one. */
  private isBreakpoint(priority: SayPriority = 'proactive'): boolean {
    if (this.voiceActive) return false;
    const now = this.deps.clock.now();
    // Just interrupted: only a direct answer may speak, nothing unprompted for 20 s.
    if (priority !== 'reply' && now - this.lastInterruptAt < 20_000) return false;
    const quietMs = now - Math.max(this.lastPartialAt, this.lastFinalAt, this.lastVoiceAt);
    if (priority === 'reply') return quietMs > 700;
    if (priority === 'method') return quietMs > 1000;
    return quietMs > this.cfg.breakpointSilenceMs && !this.brainBusy;
  }

  private isEchoWindow(): boolean {
    return this.speaker.speaking || this.deps.clock.now() < this.speakingUntil;
  }

  private idleMode(): NemoMode {
    if (this.paused) return 'idle';
    if (this.speaker?.speaking) return 'speaking';
    if (this.research?.pending || this.research?.size || this.explorer?.busy()) return 'researching';
    if (this.brainBusy) return 'thinking';
    return 'listening';
  }

  private setMode(mode: NemoMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.patch({ mode });
  }

  private addLine(text: string, final: boolean, speaker: 'room' | 'nemo') {
    this.transcript.push({ id: `t-${++this.seq}`, text, final, speaker, at: this.deps.clock.now() });
    if (this.transcript.length > 400) this.transcript.splice(0, 100);
    this.patch({ transcript: this.transcript.slice(-40) });
  }

  private pushPopup(kind: Popup['kind'], title: string, body: string, why: string, sources: Source[]) {
    this.popups = [...this.popups, { id: `p-${++this.seq}`, kind, title, body, why, sources, createdAt: this.deps.clock.now() }].slice(-6);
    this.patch({ popups: this.popups });
  }

  private publish(ops: CanvasOp[]) {
    if (!ops.length) return;
    this.deps.publisher.broadcast(this.code, { t: 'canvas', v: this.canvas.version, ops });
  }

  private lastBudget = -1;
  private patch(patch: Partial<Omit<RoomView, 'canvas' | 'code'>>, onlyIfChanged = false) {
    if ('focus' in patch) this.focus = patch.focus ?? null;
    if (onlyIfChanged && patch.budget) {
      if (patch.budget.tokens === this.lastBudget) return;
      this.lastBudget = patch.budget.tokens;
    }
    this.deps.publisher.broadcast(this.code, { t: 'view', patch });
  }

  private safe(fn: () => CanvasOp[]): CanvasOp[] {
    try {
      return fn();
    } catch {
      return [];
    }
  }
}

/** ASR sometimes hallucinates other scripts (Hangul, kana, CJK) or lone fillers on room noise. */
function looksLikeNoise(text: string): boolean {
  const letters = text.replace(/[\s\p{P}\d]/gu, '');
  if (letters.length < 2) return true;
  const foreign = (text.match(/[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}]/gu) ?? []).length;
  return foreign / letters.length > 0.2;
}

function parseOps(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (typeof json !== 'string' || !json.trim()) return [];
  try {
    const v = JSON.parse(json.trim().replace(/^```(json)?|```$/g, ''));
    return Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  } catch {
    return [];
  }
}

function buildSummary(canvas: Canvas, s: Record<string, any>, lang: Lang = 'en'): SessionSummary {
  const fr = lang === 'fr';
  const arr = (k: string) => ((s[k] as string[]) ?? []).map(String).filter(Boolean);
  const byVotes = [...canvas.cardsList()].filter((c) => c.kind === 'idea' || c.kind === 'ai_idea').sort((a, b) => b.votes - a.votes);
  const topIdeas = arr('top_ideas').length
    ? arr('top_ideas').map((line) => {
        const [n, title, why] = line.split('|').map((x) => x.trim());
        return { num: Number(n.replace('#', '')) || 0, title: title ?? n, why: why ?? '' };
      })
    : byVotes.slice(0, 3).map((c) => ({ num: c.num, title: c.title, why: c.votes ? `${c.votes} vote${c.votes > 1 ? 's' : ''}` : '' }));
  const clusters = arr('clusters').length
    ? arr('clusters').map((line) => {
        const [label, gist] = line.split('|').map((x) => x.trim());
        return { label, gist: gist ?? '' };
      })
    : canvas.clusterList().filter((c) => c.id !== 'unsorted').map((c) => ({ label: c.label, gist: '' }));
  const sources = canvas
    .cardsList()
    .flatMap((c) => c.sources)
    .filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i)
    .slice(0, 20);
  const summary: SessionSummary = {
    topic: canvas.getTopic(),
    topIdeas,
    clusters,
    risks: arr('risks'),
    openQuestions: arr('open_questions'),
    nextSteps: arr('next_steps'),
    sources,
    markdown: '',
  };
  const md = [
    `# ${summary.topic || 'Brainstorm'} — ${fr ? 'synthèse de la session' : 'session summary'}`,
    '',
    fr ? '## Meilleures idées' : '## Top ideas',
    ...summary.topIdeas.map((t) => `- **#${t.num} ${t.title}**${t.why ? ` — ${t.why}` : ''}`),
    '',
    fr ? '## Thèmes' : '## Themes',
    ...summary.clusters.map((c) => `- **${c.label}**${c.gist ? `: ${c.gist}` : ''}`),
    '',
    fr ? '## Risques' : '## Risks',
    ...summary.risks.map((r) => `- ${r}`),
    '',
    fr ? '## Questions ouvertes' : '## Open questions',
    ...summary.openQuestions.map((q) => `- ${q}`),
    '',
    fr ? '## Prochaines étapes' : '## Next steps',
    ...summary.nextSteps.map((n) => `- [ ] ${n}`),
    '',
    fr ? '## Sources' : '## Sources',
    ...summary.sources.map((x) => `- [${x.title}](${x.url})`),
  ];
  summary.markdown = md.join('\n');
  return summary;
}
