import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize as normalizePath } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { C2S, Lang, S2C } from '@nemo/shared';
import type { Logger, RoomPublisher, SpeechStream, SpeechToText } from '../../application/ports/index.ts';
import type { Room } from '../../application/room.ts';
import { DemoDirector, DEMO_TOPIC } from '../fakes/demo-script.ts';

// Driving adapter: HTTP (static client + small API) and the WebSocket protocol
// used by the host screen (mic + speakers) and read-only viewers.

interface RoomEntry {
  room: Room;
  host: WebSocket | null;
  viewers: Set<WebSocket>;
  speech: SpeechStream | null;
  demo: DemoDirector;
  lastSeen: number;
  asrFailures?: number;
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

export class Gateway implements RoomPublisher {
  private rooms = new Map<string, RoomEntry>();

  constructor(
    private createRoom: (code: string, publisher: RoomPublisher, lang: Lang) => Room,
    private asr: SpeechToText | null,
    private log: Logger,
    private staticDir?: string,
  ) {}

  // ---- RoomPublisher -----------------------------------------------------

  broadcast(code: string, msg: S2C) {
    const e = this.rooms.get(code);
    if (!e) return;
    const data = JSON.stringify(msg);
    if (e.host?.readyState === WebSocket.OPEN) e.host.send(data);
    for (const v of e.viewers) if (v.readyState === WebSocket.OPEN) v.send(data);
  }

  toHost(code: string, msg: S2C | Buffer) {
    const host = this.rooms.get(code)?.host;
    if (host?.readyState !== WebSocket.OPEN) return;
    host.send(Buffer.isBuffer(msg) ? msg : JSON.stringify(msg), { binary: Buffer.isBuffer(msg) });
  }

  // ---- server ------------------------------------------------------------

  listen(port: number) {
    const server = createServer((req, res) => this.http(req, res));
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
    wss.on('connection', (ws) => this.connection(ws));
    const alive = new WeakMap<WebSocket, boolean>();
    wss.on('connection', (ws) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
    });
    setInterval(() => {
      for (const ws of wss.clients) {
        if (!alive.get(ws)) ws.terminate();
        else {
          alive.set(ws, false);
          ws.ping();
        }
      }
      this.gc();
    }, 20_000);
    server.listen(port, () => this.log.info(`Nemo server on http://localhost:${port}`));
    return server;
  }

  private connection(ws: WebSocket) {
    let code: string | null = null;
    let role: 'host' | 'viewer' | null = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // While the scripted demo plays, the room mic is ignored so it cannot pollute the script.
        const e = code ? this.rooms.get(code) : undefined;
        if (role === 'host' && e && !e.demo.running) e.speech?.write(data as Buffer);
        return;
      }
      let msg: C2S;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const entry = code ? this.rooms.get(code) : undefined;
      switch (msg.t) {
        case 'host.create': {
          code = this.newCode();
          role = 'host';
          const e = this.addRoom(code, msg.lang === 'fr' ? 'fr' : 'en');
          e.host = ws;
          e.room.start(msg.topic?.trim() || undefined);
          this.hello(ws, e, 'host');
          void this.openSpeech(e);
          break;
        }
        case 'host.resume': {
          const e = this.rooms.get(msg.code.toUpperCase());
          if (!e) return ws.send(JSON.stringify({ t: 'error', message: 'Session not found' } satisfies S2C));
          code = e.room.code;
          role = 'host';
          e.host = ws;
          this.hello(ws, e, 'host');
          if (!e.speech) void this.openSpeech(e);
          break;
        }
        case 'join': {
          const e = this.rooms.get(msg.code.toUpperCase());
          if (!e) return ws.send(JSON.stringify({ t: 'error', message: 'No session with that code' } satisfies S2C));
          code = e.room.code;
          role = 'viewer';
          e.viewers.add(ws);
          this.hello(ws, e, 'viewer');
          break;
        }
        case 'resync':
          if (entry) this.hello(ws, entry, role ?? 'viewer');
          break;
        case 'utterance':
          if (role !== 'host' || !entry || entry.demo.running) return;
          if (msg.final) entry.room.handleFinal(msg.text);
          else entry.room.handlePartial(msg.text);
          break;
        case 'playback':
          if (role === 'host') entry?.room.handlePlayback(msg.speaking);
          break;
        case 'vad':
          if (role === 'host' && entry && !entry.demo.running) entry.room.handleVoice(msg.speaking);
          break;
        case 'interrupt':
          if (role === 'host') entry?.room.interrupt();
          break;
        case 'control':
          if (role !== 'host' || !entry) return;
          if (msg.action === 'demo') void entry.demo.run();
          else entry.room.control(msg.action);
          break;
      }
    });

    ws.on('close', () => {
      if (!code) return;
      const e = this.rooms.get(code);
      if (!e) return;
      e.lastSeen = Date.now();
      if (role === 'viewer') e.viewers.delete(ws);
      if (role === 'host' && e.host === ws) {
        e.host = null;
        e.speech?.close();
        e.speech = null;
      }
    });
  }

  private hello(ws: WebSocket, e: RoomEntry, role: 'host' | 'viewer') {
    ws.send(JSON.stringify({ t: 'hello', code: e.room.code, role, view: e.room.view(), v: e.room.version } satisfies S2C));
  }

  private addRoom(code: string, lang: Lang): RoomEntry {
    const room = this.createRoom(code, this, lang);
    const e: RoomEntry = { room, host: null, viewers: new Set(), speech: null, demo: new DemoDirector(room, lang), lastSeen: Date.now() };
    this.rooms.set(code, e);
    return e;
  }

  private async openSpeech(e: RoomEntry) {
    if (!this.asr) return;
    try {
      e.speech = await this.asr.open({
        onPartial: (t) => e.room.handlePartial(t),
        onFinal: (t) => {
          e.asrFailures = 0;
          e.room.handleFinal(t);
        },
        onError: (err) => {
          this.log.warn('ASR stream error', String(err));
          e.speech?.close();
          e.speech = null;
          // Back off: 2 s, 4 s, 8 s... up to 1 min, so a bad key does not spin.
          e.asrFailures = (e.asrFailures ?? 0) + 1;
          const delay = Math.min(60_000, 1000 * 2 ** e.asrFailures);
          setTimeout(() => e.host && !e.speech && void this.openSpeech(e), delay);
        },
      }, { lang: e.room.lang });
    } catch (err) {
      this.log.error('cannot open ASR stream', String(err));
    }
  }

  private newCode(): string {
    for (;;) {
      const c = Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
      if (!this.rooms.has(c)) return c;
    }
  }

  private gc() {
    const now = Date.now();
    for (const [code, e] of this.rooms) {
      if (!e.host && e.viewers.size === 0 && now - e.lastSeen > 2 * 3600_000) {
        e.room.dispose();
        this.rooms.delete(code);
      }
    }
  }

  // ---- HTTP --------------------------------------------------------------

  private http(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: this.rooms.size });
    const md = /^\/api\/rooms\/([A-Z]{4})\/summary\.md$/.exec(url.pathname);
    if (md) {
      const s = this.rooms.get(md[1])?.room.view().summary;
      if (!s) return json(res, 404, { error: 'no summary yet' });
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="nemo-${md[1]}.md"` });
      return res.end(s.markdown);
    }
    if (url.pathname === '/api/demo-topic') return json(res, 200, { topic: DEMO_TOPIC.en, topics: DEMO_TOPIC });
    if (!this.staticDir) return json(res, 404, { error: 'not found' });
    let file = normalizePath(join(this.staticDir, url.pathname));
    if (!file.startsWith(this.staticDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(this.staticDir, 'index.html');
    if (!existsSync(file)) return json(res, 404, { error: 'client not built' });
    const isIndex = file.endsWith('index.html');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      // Hashed assets can be cached forever; the page itself must always be fresh.
      'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
