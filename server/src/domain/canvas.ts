import type { CanvasOp, CanvasState, Card, CardKind, Cluster, Link, Source, Tone } from '@nemo/shared';
import { NEMO_ID } from '@nemo/shared';
import { normalize, similarity, slug } from './text.ts';

// The canvas aggregate. Nemo (and its sub-agents) are the only writers: every
// mutation goes through here and returns the ops to broadcast.

export const UNSORTED = 'unsorted';
const DUPLICATE_THRESHOLD = 0.62;
const TONES: Tone[] = ['blue', 'pink', 'yellow', 'mint', 'lilac'];

export interface AddCardInput {
  title: string;
  body?: string;
  kind?: CardKind;
  cluster?: string; // cluster id or label
  ownerId?: string;
  sources?: Source[];
  id?: string;
  allowDuplicate?: boolean;
}

export interface AddCardResult {
  card: Card;
  duplicateOf?: Card;
  ops: CanvasOp[];
}

export class CanvasError extends Error {}

export class Canvas {
  private topic = '';
  private clusters = new Map<string, Cluster>();
  private cards = new Map<string, Card>();
  private links = new Map<string, Link>();
  private nextNum = 1;
  private seq = 0;
  version = 0;

  constructor(private now: () => number = Date.now) {
    this.clusters.set(UNSORTED, { id: UNSORTED, label: 'Unsorted', tone: 'yellow', ownerId: NEMO_ID, createdAt: 0 });
  }

  // ---- queries -----------------------------------------------------------

  state(): CanvasState {
    return {
      topic: this.topic,
      clusters: [...this.clusters.values()],
      cards: [...this.cards.values()],
      links: [...this.links.values()],
    };
  }

  getTopic(): string {
    return this.topic;
  }

  cardCount(kinds?: CardKind[]): number {
    if (!kinds) return [...this.cards.values()].filter((c) => c.kind !== 'exploring').length;
    return [...this.cards.values()].filter((c) => kinds.includes(c.kind)).length;
  }

  cardsList(): Card[] {
    return [...this.cards.values()];
  }

  clusterList(): Cluster[] {
    return [...this.clusters.values()];
  }

  byNum(num: number): Card | undefined {
    for (const c of this.cards.values()) if (c.num === num) return c;
    return undefined;
  }

  card(id: string): Card | undefined {
    return this.cards.get(id);
  }

  findCluster(ref: string): Cluster | undefined {
    if (this.clusters.has(ref)) return this.clusters.get(ref);
    const n = normalize(ref);
    for (const c of this.clusters.values()) if (normalize(c.label) === n) return c;
    let best: Cluster | undefined;
    let bestScore = 0.5;
    for (const c of this.clusters.values()) {
      const s = similarity(c.label, ref);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  /** Compact textual view of the canvas for LLM prompts. */
  compact(maxCards = 80): string {
    const lines: string[] = [];
    if (this.topic) lines.push(`TOPIC: ${this.topic}`);
    for (const cl of this.clusters.values()) {
      const cards = [...this.cards.values()].filter((c) => c.clusterId === cl.id && c.kind !== 'exploring');
      if (cards.length === 0 && cl.id === UNSORTED) continue;
      lines.push(`[cluster "${cl.label}"]`);
      for (const c of cards.slice(-maxCards)) {
        const votes = c.votes ? ` votes=${c.votes}` : '';
        lines.push(`  #${c.num} (${c.kind}${votes}) ${c.title}`);
      }
    }
    for (const l of [...this.links.values()].slice(-40)) {
      const a = this.cards.get(l.from);
      const b = this.cards.get(l.to);
      if (a && b) lines.push(`link #${a.num} -> #${b.num}${l.label ? ` (${l.label})` : ''}`);
    }
    return lines.join('\n') || '(empty canvas)';
  }

  // ---- commands ----------------------------------------------------------

  setTopic(topic: string): CanvasOp[] {
    this.topic = topic.trim();
    return this.bump([{ op: 'topic', topic: this.topic }]);
  }

  /** Exact (id or normalized label) lookup, then creation. */
  ensureCluster(label: string, ownerId = NEMO_ID, tone?: Tone): { cluster: Cluster; ops: CanvasOp[] } {
    const n = normalize(label);
    const existing = this.clusters.get(label) ?? [...this.clusters.values()].find((c) => normalize(c.label) === n);
    if (existing) return { cluster: existing, ops: [] };
    const cluster: Cluster = {
      id: `cl-${slug(label, 24)}-${++this.seq}`,
      label: label.trim(),
      tone: tone ?? TONES[(this.clusters.size - 1) % TONES.length],
      ownerId,
      createdAt: this.now(),
    };
    this.clusters.set(cluster.id, cluster);
    return { cluster, ops: this.bump([{ op: 'cluster.upsert', cluster }]) };
  }

  addCard(input: AddCardInput): AddCardResult {
    const ownerId = input.ownerId ?? NEMO_ID;
    const title = input.title.trim();
    if (!title) throw new CanvasError('empty card title');
    const ops: CanvasOp[] = [];

    if (input.id && this.cards.has(input.id)) {
      const card = this.cards.get(input.id)!;
      Object.assign(card, {
        title,
        body: input.body ?? card.body,
        kind: input.kind ?? card.kind,
        sources: mergeSources(card.sources, input.sources ?? []),
      });
      return { card, ops: this.bump([{ op: 'card.upsert', card: { ...card } }]) };
    }

    if (!input.allowDuplicate && input.kind !== 'exploring') {
      const dup = this.findDuplicate(title);
      if (dup) {
        dup.sources = mergeSources(dup.sources, input.sources ?? []);
        if (input.body && !dup.body) dup.body = input.body;
        return { card: dup, duplicateOf: dup, ops: this.bump([{ op: 'card.upsert', card: { ...dup } }]) };
      }
    }

    let clusterId = UNSORTED;
    if (input.cluster) {
      const r = this.ensureCluster(input.cluster, ownerId);
      clusterId = r.cluster.id;
      ops.push(...r.ops);
    }

    const card: Card = {
      id: input.id ?? `c-${++this.seq}`,
      num: this.nextNum++,
      clusterId,
      kind: input.kind ?? 'idea',
      title,
      body: input.body,
      sources: input.sources ?? [],
      votes: 0,
      ownerId,
      createdAt: this.now(),
    };
    this.cards.set(card.id, card);
    ops.push({ op: 'card.upsert', card: { ...card } });
    return { card, ops: this.bump(ops) };
  }

  updateCard(id: string, patch: Partial<Pick<Card, 'title' | 'body' | 'kind' | 'sources'>>): CanvasOp[] {
    const card = this.cards.get(id);
    if (!card) return [];
    Object.assign(card, patch);
    return this.bump([{ op: 'card.upsert', card: { ...card } }]);
  }

  rename(num: number, title: string): CanvasOp[] {
    const card = this.requireNum(num);
    card.title = title.trim();
    return this.bump([{ op: 'card.upsert', card: { ...card } }]);
  }

  remove(num: number): CanvasOp[] {
    const card = this.requireNum(num);
    return this.removeCardId(card.id);
  }

  removeCardId(id: string): CanvasOp[] {
    if (!this.cards.has(id)) return [];
    this.cards.delete(id);
    const ops: CanvasOp[] = [{ op: 'card.remove', id }];
    for (const l of [...this.links.values()]) {
      if (l.from === id || l.to === id) {
        this.links.delete(l.id);
        ops.push({ op: 'link.remove', id: l.id });
      }
    }
    return this.bump(ops);
  }

  merge(nums: number[], title?: string): CanvasOp[] {
    const cards = nums.map((n) => this.requireNum(n));
    if (cards.length < 2) throw new CanvasError('merge needs at least two cards');
    const [keep, ...rest] = cards;
    const ops: CanvasOp[] = [];
    for (const c of rest) {
      keep.sources = mergeSources(keep.sources, c.sources);
      keep.votes += c.votes;
      if (!keep.body && c.body) keep.body = c.body;
      for (const l of this.links.values()) {
        if (l.from === c.id) l.from = keep.id;
        if (l.to === c.id) l.to = keep.id;
        if (l.from !== l.to) ops.push({ op: 'link.upsert', link: { ...l } });
      }
      this.cards.delete(c.id);
      ops.push({ op: 'card.remove', id: c.id });
    }
    for (const l of [...this.links.values()]) {
      if (l.from === l.to) {
        this.links.delete(l.id);
        ops.push({ op: 'link.remove', id: l.id });
      }
    }
    if (title) keep.title = title.trim();
    ops.push({ op: 'card.upsert', card: { ...keep } });
    return this.bump(ops);
  }

  move(nums: number[], clusterLabel: string): CanvasOp[] {
    // Voice commands are fuzzy ("move 7 to pricing ideas"): reuse a close cluster first.
    const close = this.findCluster(clusterLabel);
    const { cluster, ops } = close ? { cluster: close, ops: [] as CanvasOp[] } : this.ensureCluster(clusterLabel);
    const out = [...ops];
    for (const n of nums) {
      const card = this.requireNum(n);
      card.clusterId = cluster.id;
      out.push({ op: 'card.upsert', card: { ...card } });
    }
    return this.bump(out);
  }

  renameCluster(ref: string, label: string): CanvasOp[] {
    const cl = this.findCluster(ref);
    if (!cl) throw new CanvasError(`no cluster "${ref}"`);
    cl.label = label.trim();
    return this.bump([{ op: 'cluster.upsert', cluster: { ...cl } }]);
  }

  removeCluster(ref: string): CanvasOp[] {
    const cl = this.findCluster(ref);
    if (!cl || cl.id === UNSORTED) return [];
    const ops: CanvasOp[] = [];
    for (const c of this.cards.values()) {
      if (c.clusterId === cl.id) {
        c.clusterId = UNSORTED;
        ops.push({ op: 'card.upsert', card: { ...c } });
      }
    }
    this.clusters.delete(cl.id);
    ops.push({ op: 'cluster.remove', id: cl.id });
    return this.bump(ops);
  }

  link(fromNum: number, toNum: number, label?: string): CanvasOp[] {
    const a = this.requireNum(fromNum);
    const b = this.requireNum(toNum);
    return this.linkIds(a.id, b.id, label);
  }

  linkIds(fromId: string, toId: string, label?: string): CanvasOp[] {
    if (fromId === toId || !this.cards.has(fromId) || !this.cards.has(toId)) return [];
    const id = `l-${fromId}-${toId}`;
    const link: Link = { id, from: fromId, to: toId, label };
    this.links.set(id, link);
    return this.bump([{ op: 'link.upsert', link }]);
  }

  vote(num: number, delta = 1): CanvasOp[] {
    const card = this.requireNum(num);
    card.votes = Math.max(0, card.votes + delta);
    return this.bump([{ op: 'card.upsert', card: { ...card } }]);
  }

  // ---- internals ---------------------------------------------------------

  private findDuplicate(title: string): Card | undefined {
    let best: Card | undefined;
    let bestScore = DUPLICATE_THRESHOLD;
    for (const c of this.cards.values()) {
      if (c.kind === 'exploring') continue;
      const s = similarity(c.title, title);
      if (s >= bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  private requireNum(num: number): Card {
    const c = this.byNum(num);
    if (!c) throw new CanvasError(`no card #${num}`);
    return c;
  }

  private bump(ops: CanvasOp[]): CanvasOp[] {
    if (ops.length) this.version++;
    return ops;
  }
}

function mergeSources(a: Source[], b: Source[]): Source[] {
  const seen = new Set(a.map((s) => s.url));
  return [...a, ...b.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url))].slice(0, 6);
}
