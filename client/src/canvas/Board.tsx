import { memo, useEffect, useRef, useState } from 'react';
import { Background, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { motion } from 'motion/react';
import { LightbulbIcon, LinkSimpleIcon, MagnifyingGlassIcon, PuzzlePieceIcon, QuestionIcon, SparkleIcon, StarIcon, WarningIcon } from '@phosphor-icons/react';
import type { CanvasState, Card, CardKind, Cluster, Lang, RoomView, Tone } from '@nemo/shared';
import { KIND_LABELS, tr } from '../i18n';
import { CARD_H, CARD_W, MINI_H, MINI_W, layout } from './layout';

const KIND: Record<CardKind, { bg: string; label: string; Icon: typeof LightbulbIcon; badge: string }> = {
  idea: { bg: 'bg-sun-soft', label: 'Idea', Icon: LightbulbIcon, badge: 'bg-sun' },
  ai_idea: { bg: 'bg-white', label: 'Nemo spark', Icon: SparkleIcon, badge: 'bg-brand text-white' },
  fact: { bg: 'bg-brand-soft', label: 'Sourced', Icon: MagnifyingGlassIcon, badge: 'bg-brand text-white' },
  risk: { bg: 'bg-pink-soft', label: 'Concern', Icon: WarningIcon, badge: 'bg-pink' },
  question: { bg: 'bg-white', label: 'Question', Icon: QuestionIcon, badge: 'bg-lilac' },
  decision: { bg: 'bg-sun', label: 'Shortlisted', Icon: StarIcon, badge: 'bg-pink' },
  feature: { bg: 'bg-mint-soft', label: 'Feature', Icon: PuzzlePieceIcon, badge: 'bg-mint' },
  exploring: { bg: 'shimmer', label: 'Agent at work', Icon: MagnifyingGlassIcon, badge: 'bg-brand text-white' },
};

const TONE: Record<Tone, { soft: string; strong: string }> = {
  blue: { soft: 'bg-brand-soft/60', strong: 'bg-brand text-white' },
  pink: { soft: 'bg-pink-soft/70', strong: 'bg-pink' },
  yellow: { soft: 'bg-sun-soft/70', strong: 'bg-sun' },
  mint: { soft: 'bg-mint-soft/70', strong: 'bg-mint' },
  lilac: { soft: 'bg-lilac-soft/70', strong: 'bg-lilac' },
};

type CardNode = Node<{ card: Card; fresh: boolean; lang: Lang; mini: boolean; hot: boolean }, 'card'>;
type ClusterNode = Node<{ cluster: Cluster; count: number; lang: Lang }, 'cluster'>;

function domain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const anchors = (
  <>
    {/* invisible anchors so links can be drawn between cards */}
    <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0 !pointer-events-none" />
    <Handle type="source" position={Position.Right} isConnectable={false} className="!opacity-0 !pointer-events-none" />
  </>
);

/** Background material (agent findings, sourced facts): a small one-glance tile. */
function MiniCard({ card, fresh }: { card: Card; fresh: boolean }) {
  const k = KIND[card.kind];
  return (
    <motion.div
      initial={fresh ? { opacity: 0, scale: 0.7 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 360, damping: 24 }}
      style={{ width: MINI_W, height: MINI_H }}
      className={`${k.bg} relative rounded-xl border-2 border-ink/80 ${card.kind === 'exploring' ? 'border-dashed' : ''} shadow-brut-sm px-2 py-1.5 flex items-start gap-1.5 overflow-hidden opacity-90`}
      title={card.body ? `${card.title}: ${card.body}` : card.title}
    >
      {anchors}
      <span className={`${k.badge} shrink-0 border-2 border-ink rounded-full min-w-6 h-6 px-1 grid place-items-center font-display font-extrabold text-[11px]`}>
        {card.kind === 'exploring' ? <MagnifyingGlassIcon size={12} weight="bold" /> : card.num}
      </span>
      <div className="min-w-0">
        <div className="font-display font-bold text-[12px] leading-tight line-clamp-2">{card.title}</div>
        {card.sources[0] && <div className="text-[10px] font-bold text-brand truncate">{domain(card.sources[0].url)}</div>}
      </div>
    </motion.div>
  );
}

const CardView = memo(function CardView({ data }: NodeProps<CardNode>) {
  const { card, fresh, lang, mini, hot } = data;
  if (mini) return <MiniCard card={card} fresh={fresh} />;
  const k = KIND[card.kind];
  const dashed = card.kind === 'ai_idea' || card.kind === 'question' || card.kind === 'exploring';
  return (
    <motion.div
      initial={fresh ? { opacity: 0, scale: 0.5, rotate: -6, y: 12 } : false}
      animate={{ opacity: 1, scale: 1, rotate: 0, y: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 20 }}
      style={{ width: CARD_W, height: CARD_H, boxShadow: hot ? '0 0 0 5px #FFD43B, 4px 4px 0 0 #1A1A2E' : undefined }}
      className={`${k.bg} relative rounded-card border-2 border-ink ${dashed ? 'border-dashed' : ''} shadow-brut p-3 pt-2.5 flex flex-col overflow-hidden transition-shadow`}
    >
      {anchors}
      <div className="flex items-center gap-2">
        <span className={`${k.badge} border-2 border-ink rounded-full min-w-8 h-8 px-1.5 grid place-items-center font-display font-extrabold text-sm`}>
          {card.kind === 'exploring' ? <MagnifyingGlassIcon size={16} weight="bold" /> : card.num}
        </span>
        <span className="flex items-center gap-1 text-[11px] font-display font-bold uppercase tracking-wide opacity-70">
          <k.Icon size={13} weight="bold" />
          {KIND_LABELS[lang][card.kind]}
        </span>
        {card.votes > 0 && (
          <span className="ml-auto flex gap-0.5">
            {Array.from({ length: Math.min(card.votes, 6) }).map((_, i) => (
              <motion.span key={i} initial={{ scale: 0 }} animate={{ scale: 1 }} className="w-3 h-3 rounded-full bg-pink border-2 border-ink" />
            ))}
          </span>
        )}
      </div>
      <h3 className="mt-1.5 font-display font-bold text-[15px] leading-snug line-clamp-2 shrink-0">{card.title}</h3>
      {card.body && <p className={`mt-0.5 text-[12.5px] leading-snug opacity-80 ${card.sources[0] ? 'line-clamp-1' : 'line-clamp-2'}`}>{card.body}</p>}
      {card.sources[0] && (
        <a
          href={card.sources[0].url}
          target="_blank"
          rel="noreferrer"
          className="mt-auto pt-1 flex items-center gap-1 text-[11px] font-bold text-brand truncate nodrag nopan shrink-0"
          title={card.sources[0].title}
        >
          <LinkSimpleIcon size={12} weight="bold" />
          {domain(card.sources[0].url)}
          {card.sources.length > 1 && <span className="opacity-60">+{card.sources.length - 1}</span>}
        </a>
      )}
    </motion.div>
  );
});

const ClusterView = memo(function ClusterView({ data, width, height }: NodeProps<ClusterNode>) {
  const t = TONE[data.cluster.tone];
  const agent = data.cluster.ownerId !== 'nemo';
  return (
    <div style={{ width, height }} className={`cluster-frame relative rounded-[24px] border-2 border-ink/70 border-dashed ${t.soft}`}>
      <span className={`${t.strong} absolute -top-4 left-4 border-2 border-ink rounded-full px-3 py-1 font-display font-extrabold text-sm shadow-brut-sm flex items-center gap-1.5 max-w-[90%] truncate`}>
        {agent && <MagnifyingGlassIcon size={14} weight="bold" />}
        {data.cluster.id === 'unsorted' ? tr(data.lang, 'freshIdeas') : data.cluster.label}
        <span className="opacity-60 font-bold">{data.count}</span>
      </span>
    </div>
  );
});

type TileNode = Node<{ cluster: Cluster; index: number; count: number; top: string[] }, 'tile'>;

/** Overview tile: one theme at a glance (name, size, its 3 strongest ideas). */
const TileView = memo(function TileView({ data }: NodeProps<TileNode>) {
  const t = TONE[data.cluster.tone];
  return (
    <div style={{ width: TILE_W, height: TILE_H }} className={`${t.soft} rounded-[26px] border-[3px] border-ink shadow-brut-lg p-5 flex flex-col`}>
      <div className="flex items-center gap-3">
        <span className={`${t.strong} border-2 border-ink rounded-full w-11 h-11 grid place-items-center font-display font-extrabold text-xl shrink-0`}>{data.index}</span>
        <span className="font-display font-extrabold text-2xl leading-tight line-clamp-2">{data.cluster.label}</span>
        <span className="ml-auto font-display font-extrabold text-xl opacity-60">{data.count}</span>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {data.top.map((title, i) => (
          <li key={i} className="font-display font-bold text-[17px] leading-snug line-clamp-1">
            • {title}
          </li>
        ))}
      </ul>
    </div>
  );
});

const TILE_W = 380;
const TILE_H = 210;

const nodeTypes = { card: CardView, cluster: ClusterView, tile: TileView };
// Keep cards clear of the overlays (top bar, right column, bottom dock).
const FIT_PADDING = { top: '84px', right: '56px', bottom: '150px', left: '56px' } as const;
const HOT_COUNT = 6;

type Focus = RoomView['focus'];
const FOCUS_HOLD_MS = 25_000;
const MAX_ON_SCREEN = 10;

function Inner({ state, lang, focus }: { state: CanvasState; lang: Lang; focus: Focus }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const seen = useRef(new Set<string>());
  const count = useRef(0);
  const lastFocus = useRef('');
  // Re-evaluate when an explicit focus expires, so the camera goes back to following the talk.
  const [expired, setExpired] = useState(0);
  useEffect(() => {
    if (!focus) return;
    const ms = FOCUS_HOLD_MS - (Date.now() - focus.at);
    if (ms <= 0) return;
    const timer = setTimeout(() => setExpired((x) => x + 1), ms + 50);
    return () => clearTimeout(timer);
  }, [focus]);
  const { fitView } = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    // Overview: one tile per theme instead of every post-it (readable with 150 ideas).
    if (focus && focus.kind === 'all' && Date.now() - focus.at < FOCUS_HOLD_MS) {
      const themes = themeList(state);
      const cols = Math.max(1, Math.ceil(Math.sqrt(themes.length * 1.4)));
      setNodes(
        themes.map((c, i) => {
          const cards = state.cards.filter((k) => k.clusterId === c.id && k.kind !== 'exploring');
          const top = [...cards].sort((a, b) => b.votes - a.votes || b.createdAt - a.createdAt).slice(0, 3).map((k) => k.title);
          return {
            id: `tile-${c.id}`,
            type: 'tile',
            position: { x: (i % cols) * (TILE_W + 48), y: Math.floor(i / cols) * (TILE_H + 48) },
            data: { cluster: c, index: i + 1, count: cards.length, top },
            draggable: false,
            selectable: false,
          };
        }),
      );
      setEdges([]);
      count.current = 0;
      lastFocus.current = `${focus.kind}:${focus.at}`;
      setTimeout(() => void fitView({ duration: 700, padding: FIT_PADDING, maxZoom: 1 }), 60);
      return;
    }
    void layout(state).then((placed) => {
      if (cancelled) return;
      const ns: Node[] = [];
      for (const c of placed.clusters) {
        ns.push({
          id: c.cluster.id,
          type: 'cluster',
          position: { x: c.x, y: c.y },
          width: c.w,
          height: c.h,
          data: { cluster: c.cluster, count: placed.cards.filter((k) => k.clusterId === c.cluster.id).length, lang },
          selectable: false,
          draggable: false,
          zIndex: 0,
        });
      }
      // The "hot" points: the theme where the latest idea landed (max 10 cards).
      // The camera follows it, so the screen shows one readable subject at a time.
      const main = placed.cards.filter((k) => !k.mini).sort((a, b) => b.card.createdAt - a.card.createdAt);
      const activeCluster = main[0]?.clusterId;
      const hot = main
        .filter((k) => k.clusterId === activeCluster)
        .slice(0, MAX_ON_SCREEN)
        .map((k) => k.card.id);
      let newMain = false;
      for (const k of placed.cards) {
        const fresh = !seen.current.has(k.card.id);
        seen.current.add(k.card.id);
        if (fresh && !k.mini) newMain = true;
        ns.push({
          id: k.card.id,
          type: 'card',
          parentId: k.clusterId,
          position: { x: k.x, y: k.y },
          data: { card: k.card, fresh, lang, mini: k.mini, hot: hot.includes(k.card.id) },
          draggable: false,
          zIndex: 1,
        });
      }
      setNodes(ns);
      setEdges(
        state.links.map((l) => ({
          id: l.id,
          source: l.from,
          target: l.to,
          animated: true,
          type: 'default',
          style: { strokeDasharray: '6 5', opacity: 0.3 },
          zIndex: 2,
        })),
      );
      // An explicit "show me…" holds the camera for a while; otherwise follow the active theme.
      const held = focus && Date.now() - focus.at < FOCUS_HOLD_MS;
      const first = count.current === 0 && placed.cards.length > 0;
      count.current = placed.cards.length;
      const focusKey = focus ? `${focus.kind}:${focus.ref ?? ''}:${focus.at}` : '';
      const focusChanged = focusKey !== lastFocus.current;
      lastFocus.current = focusKey;
      const go = (ids: string[] | null, maxZoom = 1.25) =>
        setTimeout(
          () => void fitView({ ...(ids ? { nodes: ids.map((id) => ({ id })) } : {}), duration: 800, padding: FIT_PADDING, maxZoom, minZoom: 0.2 }),
          60,
        );
      if (held && (focusChanged || newMain)) {
        if (focus!.kind === 'research') go(placed.cards.filter((k) => k.mini).map((k) => k.card.id).slice(-24), 1.2);
        else if (focus!.kind === 'cluster') {
          const ids = placed.cards.filter((k) => k.clusterId === focus!.ref).map((k) => k.card.id);
          go(ids.length ? [focus!.ref!, ...ids] : null, 1.6);
        } else if (focus!.kind === 'card' && focus!.ref) go([focus!.ref], 1.3);
      } else if (!held && (newMain || first) && hot.length) go(hot);
      else if (first) go(null, 1.1);
    });
    return () => {
      cancelled = true;
    };
  }, [state, fitView, lang, focus, expired]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      panOnDrag
      zoomOnScroll
      zoomOnDoubleClick={false}
      minZoom={0.15}
      maxZoom={1.6}
      fitView
      fitViewOptions={{ padding: FIT_PADDING }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} size={1.6} color="#1A1A2E26" />
    </ReactFlow>
  );
}

/** Themes in display order (same rule as the server): Nemo's clusters that have cards. */
export function themeList(state: CanvasState): Cluster[] {
  const used = new Set(state.cards.map((c) => c.clusterId));
  return state.clusters.filter((c) => c.ownerId === 'nemo' && c.id !== 'unsorted' && used.has(c.id)).sort((a, b) => a.createdAt - b.createdAt);
}

export function Board({ state, lang = 'en', focus = null }: { state: CanvasState; lang?: Lang; focus?: Focus }) {
  return (
    <ReactFlowProvider>
      <div className="absolute inset-0">
        <Inner state={state} lang={lang} focus={focus} />
      </div>
    </ReactFlowProvider>
  );
}
