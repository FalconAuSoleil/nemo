import { useEffect, useReducer, useRef } from 'react';
import type { C2S, CanvasOp, CanvasState, RoomView, S2C } from '@nemo/shared';

// Client-side room state: a snapshot from `hello`, then canvas ops + view patches.

export interface RoomState {
  status: 'connecting' | 'open' | 'closed' | 'error';
  error?: string;
  role?: 'host' | 'viewer';
  view?: RoomView;
  v: number;
}

type Action = { type: 'msg'; msg: S2C } | { type: 'status'; status: RoomState['status']; error?: string };

function applyOps(canvas: CanvasState, ops: CanvasOp[]): CanvasState {
  const next: CanvasState = { topic: canvas.topic, clusters: [...canvas.clusters], cards: [...canvas.cards], links: [...canvas.links] };
  for (const o of ops) {
    switch (o.op) {
      case 'topic':
        next.topic = o.topic;
        break;
      case 'cluster.upsert': {
        const i = next.clusters.findIndex((c) => c.id === o.cluster.id);
        if (i >= 0) next.clusters[i] = o.cluster;
        else next.clusters.push(o.cluster);
        break;
      }
      case 'cluster.remove':
        next.clusters = next.clusters.filter((c) => c.id !== o.id);
        break;
      case 'card.upsert': {
        const i = next.cards.findIndex((c) => c.id === o.card.id);
        if (i >= 0) next.cards[i] = o.card;
        else next.cards.push(o.card);
        break;
      }
      case 'card.remove':
        next.cards = next.cards.filter((c) => c.id !== o.id);
        break;
      case 'link.upsert': {
        const i = next.links.findIndex((l) => l.id === o.link.id);
        if (i >= 0) next.links[i] = o.link;
        else next.links.push(o.link);
        break;
      }
      case 'link.remove':
        next.links = next.links.filter((l) => l.id !== o.id);
        break;
    }
  }
  return next;
}

function reducer(s: RoomState, a: Action): RoomState {
  if (a.type === 'status') return { ...s, status: a.status, error: a.error ?? s.error };
  const m = a.msg;
  switch (m.t) {
    case 'hello':
      return { status: 'open', role: m.role, view: m.view, v: m.v };
    case 'canvas':
      if (!s.view) return s;
      return { ...s, v: m.v, view: { ...s.view, canvas: applyOps(s.view.canvas, m.ops) } };
    case 'view':
      if (!s.view) return s;
      return { ...s, view: { ...s.view, ...m.patch } as RoomView };
    case 'error':
      return { ...s, status: 'error', error: m.message };
    default:
      return s;
  }
}

export interface RoomConnection {
  send(msg: C2S): void;
  sendBinary(buf: ArrayBuffer): void;
}

export function useRoom(
  open: C2S | null,
  onSpecial?: (msg: S2C) => void,
  onBinary?: (buf: ArrayBuffer) => void,
): [RoomState, RoomConnection] {
  const [state, dispatch] = useReducer(reducer, { status: 'connecting', v: 0 });
  const wsRef = useRef<WebSocket | null>(null);
  const handlers = useRef({ onSpecial, onBinary });
  handlers.current = { onSpecial, onBinary };
  const openRef = useRef(open);
  openRef.current = open;
  const key = open ? JSON.stringify(open) : '';

  useEffect(() => {
    if (!openRef.current) return;
    let closed = false;
    let delay = 500;
    let retry: number | undefined;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 500;
        // After a reconnect, a host resumes its room instead of creating a new one.
        const first = openRef.current!;
        const code = sessionStorage.getItem('nemo.host.code');
        ws.send(JSON.stringify(first.t === 'host.create' && code && reconnecting ? { t: 'host.resume', code } : first));
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return handlers.current.onBinary?.(e.data as ArrayBuffer);
        const msg = JSON.parse(e.data) as S2C;
        if (msg.t === 'hello' && msg.role === 'host') sessionStorage.setItem('nemo.host.code', msg.code);
        if (msg.t === 'say' || msg.t === 'say.audio.start' || msg.t === 'say.audio.end') handlers.current.onSpecial?.(msg);
        else dispatch({ type: 'msg', msg });
      };
      ws.onclose = () => {
        if (closed) return;
        dispatch({ type: 'status', status: 'connecting' });
        reconnecting = true;
        retry = window.setTimeout(connect, (delay = Math.min(delay * 2, 5000)));
      };
    };
    let reconnecting = false;
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const conn: RoomConnection = {
    send: (msg) => wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify(msg)),
    sendBinary: (buf) => wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(buf),
  };
  return [state, conn];
}
