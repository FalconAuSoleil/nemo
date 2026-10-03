import PQueue from 'p-queue';
import type { AgentStatus, CanvasOp, Lang, Tone } from '@nemo/shared';
import { languageRule, t } from '../../domain/i18n.ts';
import type { Canvas } from '../../domain/canvas.ts';
import { normalize, similarity, slug, truncateWords } from '../../domain/text.ts';
import type { ChatMessage, LanguageModel, Logger, WebSearch } from '../ports/index.ts';
import { EXPLORER_TOOLS, PLANNER_TOOL } from './prompts.ts';

// Orchestrator-worker: a theme is split into angles, each explored by a
// sub-agent running in parallel. Sub-agents never touch the canvas directly:
// they emit cards into their own lane through the canvas aggregate.

const TONES: Tone[] = ['blue', 'pink', 'mint', 'lilac', 'yellow'];
const DEFAULT_ANGLES = [
  { angle: 'Existing solutions', objective: 'Find products, startups or programs that already address this, and how they work.' },
  { angle: 'User needs', objective: 'Find evidence about who has this problem, how much it hurts and what they want.' },
  { angle: 'Constraints', objective: 'Find technical, cost or adoption constraints.' },
];

export interface ExplorerHooks {
  apply(ops: CanvasOp[]): void;
  status(s: AgentStatus): void;
  finished(theme: string, summaries: string[]): void;
}

export interface ExplorerConfig {
  maxAgents: number;
  maxSearches: number;
  maxCards: number;
  deadlineMs: number;
}

export class Explorer {
  private tasks = new PQueue({ concurrency: 3 });
  private wave = new AbortController();
  private statuses = new Map<string, AgentStatus>();
  private seq = 0;

  constructor(
    private llm: LanguageModel,
    private search: WebSearch,
    private canvas: Canvas,
    private hooks: ExplorerHooks,
    private log: Logger,
    private cfg: ExplorerConfig = { maxAgents: 3, maxSearches: 3, maxCards: 3, deadlineMs: 90_000 },
    private lang: Lang = 'en',
  ) {}

  list(): AgentStatus[] {
    return [...this.statuses.values()];
  }

  busy(): boolean {
    return this.list().some((s) => ['queued', 'searching', 'reading', 'writing'].includes(s.state));
  }

  cancelAll() {
    this.wave.abort();
    this.tasks.clear();
    this.wave = new AbortController();
  }

  /** Fire and forget: never awaited by the voice loop. */
  explore(theme: string, parentNum?: number): number {
    const wave = this.wave.signal;
    const waveId = ++this.seq;
    void (async () => {
      const angles = await this.plan(theme, wave).catch(() => DEFAULT_ANGLES.slice(0, this.cfg.maxAgents));
      const summaries: string[] = [];
      const parent = parentNum ? this.canvas.byNum(parentNum) : this.closestCard(theme);
      const runs = angles.map(({ angle, objective }, i) => {
        const agentId = `agent-${waveId}-${slug(angle, 16)}`;
        // The sub-area is the lane's name; a later wave on the same sub-area gets its own lane.
        const laneLabel = this.canvas.clusterList().some((c) => normalize(c.label) === normalize(angle)) ? `${angle} (${waveId})` : angle;
        const tone = TONES[i % TONES.length];
        const lane = this.canvas.ensureCluster(laneLabel, agentId, tone);
        this.hooks.apply(lane.ops);
        const placeholder = this.canvas.addCard({
          id: `${agentId}-ph`,
          title: t(this.lang, 'exploringCard', { angle: angle.toLowerCase() }),
          kind: 'exploring',
          cluster: lane.cluster.id,
          ownerId: agentId,
        });
        this.hooks.apply(placeholder.ops);
        if (parent) this.hooks.apply(this.canvas.linkIds(parent.id, placeholder.card.id, angle.toLowerCase()));
        const status: AgentStatus = { agentId, label: angle, theme, tone, state: 'queued', cards: 0, searches: 0 };
        this.statuses.set(agentId, status);
        this.hooks.status({ ...status });
        const set = (patch: Partial<AgentStatus>) => {
          Object.assign(status, patch);
          this.hooks.status({ ...status });
        };
        return this.tasks.add(async () => {
          try {
            const summary = await this.runAgent({ agentId, angle, objective, theme, laneId: lane.cluster.id, siblings: angles.map((a) => a.angle), parentId: parent?.id }, set, wave);
            set({ state: 'done', summary });
            summaries.push(`${angle}: ${summary}`);
          } catch (err) {
            set({ state: wave.aborted ? 'stopped' : 'error' });
            if (!wave.aborted) this.log.warn(`explorer ${agentId} failed`, String(err));
          } finally {
            this.hooks.apply(this.canvas.removeCardId(placeholder.card.id));
          }
        });
      });
      await Promise.allSettled(runs);
      if (!wave.aborted && summaries.length) this.hooks.finished(theme, summaries);
    })();
    return Math.min(this.cfg.maxAgents, 4);
  }

  /** The existing idea a free-text theme most likely refers to (shared word stems, ignoring the topic's own words). */
  private closestCard(theme: string) {
    const stems = (t: string) => new Set(normalize(t).split(' ').filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
    const topic = stems(this.canvas.getTopic());
    const wanted = [...stems(theme)].filter((s) => !topic.has(s));
    let best: { id: string; score: number } | undefined;
    for (const c of this.canvas.cardsList()) {
      if (c.kind !== 'idea' && c.kind !== 'ai_idea') continue;
      const have = stems(c.title);
      const score = wanted.filter((s) => have.has(s)).length + similarity(c.title, theme);
      if (score >= 1 && (!best || score > best.score)) best = { id: c.id, score };
    }
    return best ? this.canvas.card(best.id) : undefined;
  }

  private async plan(theme: string, signal: AbortSignal) {
    const res = await this.llm.chat({
      tier: 'fast',
      system: `You plan parallel web research for a brainstorming group. Split the request into CONCRETE, non-overlapping sub-areas that match its intent (e.g. for "pain points in enterprise processes": "Accounting close", "HR onboarding", "Procurement"; for a product: "Existing competitors", "Target users", "Pricing"). Angle labels are 1-3 words. Never abstract angles, never security, privacy, compliance or legal unless asked.\n${languageRule(this.lang)}`,
      messages: [{ role: 'user', content: `Session topic: ${this.canvas.getTopic() || 'n/a'}\nTheme to explore: ${theme}\nReturn ${this.cfg.maxAgents} angles.` }],
      tools: [PLANNER_TOOL],
      toolChoice: { name: 'plan' },
      temperature: 0.4,
      maxTokens: 400,
      signal,
    });
    const args = res.toolCalls[0]?.args as { angles?: string[]; objectives?: string[] } | undefined;
    const angles = (args?.angles ?? []).filter(Boolean).slice(0, this.cfg.maxAgents);
    if (angles.length < 2) return DEFAULT_ANGLES.slice(0, this.cfg.maxAgents);
    return angles.map((angle, i) => ({ angle: truncateWords(angle, 4), objective: args?.objectives?.[i] ?? `Research the ${angle} angle.` }));
  }

  private async runAgent(
    b: { agentId: string; angle: string; objective: string; theme: string; laneId: string; siblings: string[]; parentId?: string },
    set: (p: Partial<AgentStatus>) => void,
    wave: AbortSignal,
  ): Promise<string> {
    const deadline = AbortSignal.any([wave, AbortSignal.timeout(this.cfg.deadlineMs)]);
    const existing = this.canvas
      .cardsList()
      .filter((c) => c.kind !== 'exploring')
      .slice(-40)
      .map((c) => c.title);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: `Theme: ${b.theme}\nSession topic: ${this.canvas.getTopic() || 'n/a'}\nYour angle: ${b.angle}\nObjective: ${b.objective}\nOther agents cover: ${b.siblings.filter((s) => s !== b.angle).join(', ')} (do not cover those).\nAlready on the canvas (do not repeat): ${existing.join('; ') || 'nothing yet'}`,
      },
    ];
    const system = `You are a research sub-agent of Nemo, a brainstorming facilitator. Work fast.
Search the web (max ${this.cfg.maxSearches} searches), then call add_card as soon as you have a concrete finding (max ${this.cfg.maxCards} cards, each with its source url).
Every card is ONE concrete, specific finding, never generic advice and never a question:
- title: "<named process, product or actor>: <precise pain point or fact>" (max 10 words), e.g. "Invoice matching: 3-way match done by hand";
- detail: the evidence (a number, a real company or tool, how it happens), max 30 words.
No security, privacy, compliance or legal cards unless the theme is about them. Finish with "finish".
${languageRule(this.lang)}`;
    let searches = 0;
    let cards = 0;
    for (let turn = 0; turn < this.cfg.maxSearches + this.cfg.maxCards + 2; turn++) {
      if (deadline.aborted) break;
      const over = searches >= this.cfg.maxSearches || cards >= this.cfg.maxCards;
      set({ state: cards ? 'writing' : searches ? 'reading' : 'searching' });
      const res = await this.llm.chat({
        tier: 'smart',
        system,
        messages,
        tools: EXPLORER_TOOLS,
        toolChoice: cards >= this.cfg.maxCards ? { name: 'finish' } : 'required',
        temperature: 0.6,
        maxTokens: 700,
        signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]),
      });
      if (!res.toolCalls.length) break;
      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        let out: unknown = 'ok';
        if (call.name === 'web_search') {
          // Count every call, even several in one turn.
          if (over || searches >= this.cfg.maxSearches) out = 'Search budget exhausted. Write your cards now or finish.';
          else {
            searches++;
            set({ state: 'searching', searches });
            const r = await this.search.search(String(call.args.query ?? b.theme), { depth: 'basic', maxResults: 5, language: this.lang }, deadline);
            out = r.results.map((x) => ({ title: x.title, url: x.url, content: x.content.slice(0, 900) }));
          }
        } else if (call.name === 'add_card') {
          const url = String(call.args.source_url ?? '');
          const r = this.canvas.addCard({
            title: truncateWords(String(call.args.title ?? ''), 10),
            body: String(call.args.detail ?? ''),
            kind: 'fact',
            cluster: b.laneId,
            ownerId: b.agentId,
            sources: url ? [{ title: String(call.args.source_title ?? url), url }] : [],
          });
          this.hooks.apply(r.ops);
          // Sub-themes stay visually attached to the idea they explore.
          if (b.parentId && !r.duplicateOf) this.hooks.apply(this.canvas.linkIds(b.parentId, r.card.id, b.angle.toLowerCase()));
          if (r.duplicateOf) out = `Duplicate of card #${r.duplicateOf.num}. Find something different.`;
          else {
            cards++;
            set({ state: 'writing', cards });
            out = `Card #${r.card.num} written.`;
          }
        } else if (call.name === 'finish') {
          return truncateWords(String(call.args.summary ?? `${cards} cards on ${b.angle}`), 22);
        }
        messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(out) });
      }
    }
    return t(this.lang, 'findings', { n: cards, angle: b.angle.toLowerCase() });
  }
}
