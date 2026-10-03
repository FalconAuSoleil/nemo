import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { CanvasState, Card, Cluster } from '@nemo/shared';

// Deterministic, stable layout: clusters are packed on the board, cards are
// packed inside their cluster in arrival order, so old cards barely move.

export const CARD_W = 248;
export const CARD_H = 128;
// Background material (agent findings, sourced facts) is drawn small.
export const MINI_W = 196;
export const MINI_H = 66;

export function isMini(card: Card, cluster?: Cluster): boolean {
  return card.kind === 'fact' || card.kind === 'exploring' || (!!cluster && cluster.ownerId !== 'nemo');
}
const elk = new ELK();

export interface Placed {
  clusters: { cluster: Cluster; x: number; y: number; w: number; h: number }[];
  cards: { card: Card; clusterId: string; x: number; y: number; mini: boolean }[];
}

export async function layout(state: CanvasState): Promise<Placed> {
  const clusters = [...state.clusters].sort((a, b) => a.createdAt - b.createdAt);
  const byCluster = new Map<string, Card[]>();
  for (const c of [...state.cards].sort((a, b) => a.num - b.num)) {
    const list = byCluster.get(c.clusterId) ?? [];
    list.push(c);
    byCluster.set(c.clusterId, list);
  }
  const visible = clusters.filter((c) => (byCluster.get(c.id)?.length ?? 0) > 0);
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'rectpacking',
      'elk.aspectRatio': '1.8',
      'elk.spacing.nodeNode': '48',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
    },
    children: visible.map((cl) => {
      const n = byCluster.get(cl.id)!.length;
      return {
        id: cl.id,
        layoutOptions: {
          'elk.algorithm': 'rectpacking',
          'elk.aspectRatio': n > 6 ? '1.6' : '1.3',
          'elk.spacing.nodeNode': '16',
          'elk.padding': '[top=52,left=18,bottom=18,right=18]',
        },
        children: byCluster.get(cl.id)!.map((k) => (isMini(k, cl) ? { id: k.id, width: MINI_W, height: MINI_H } : { id: k.id, width: CARD_W, height: CARD_H })),
      };
    }),
  };
  const res = await elk.layout(graph);
  const out: Placed = { clusters: [], cards: [] };
  for (const n of res.children ?? []) {
    const cluster = visible.find((c) => c.id === n.id)!;
    out.clusters.push({ cluster, x: n.x ?? 0, y: n.y ?? 0, w: Math.max(n.width ?? MINI_W, MINI_W + 36), h: n.height ?? MINI_H });
    for (const k of n.children ?? []) {
      const card = state.cards.find((c) => c.id === k.id)!;
      out.cards.push({ card, clusterId: n.id, x: k.x ?? 0, y: k.y ?? 0, mini: isMini(card, cluster) });
    }
  }
  return out;
}
