import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { NemotronLanguageModel } from '../src/adapters/outbound/chat-completions.ts';
import { NimRealtimeAsr } from '../src/adapters/outbound/nim-asr.ts';
import { MagpieTts } from '../src/adapters/outbound/magpie-tts.ts';
import { TavilyWebSearch } from '../src/adapters/outbound/tavily.ts';

const log = { info() {}, warn() {}, error() {} };
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function body(req: import('node:http').IncomingMessage) {
  let raw = '';
  for await (const c of req) raw += c;
  return raw;
}

describe('NemotronLanguageModel (OpenAI-compatible mock)', () => {
  it('sends tools, a named tool_choice and disables thinking; parses tool calls', async () => {
    const seen: any[] = [];
    const url = await listen(
      createServer(async (req, res) => {
        const b = JSON.parse(await body(req));
        seen.push(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 0,
            model: b.model,
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'act', arguments: '{"intent":"chit_chat","add_ideas":["A"]}' } }] } }],
          }),
        );
      }),
    );
    const llm = new NemotronLanguageModel({ apiKey: 'k', baseURL: `${url}/v1/`, models: { fast: 'nvidia/Nemotron-3_5-Lightning', smart: 's' } }, log);
    const r = await llm.chat({ tier: 'fast', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'act', description: 'd', parameters: { type: 'object' } }], toolChoice: { name: 'act' } });
    expect(r.toolCalls[0]).toMatchObject({ name: 'act', args: { add_ideas: ['A'] } });
    expect(seen[0].model).toBe('nvidia/Nemotron-3_5-Lightning');
    expect(seen[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(seen[0].tool_choice).toEqual({ type: 'function', function: { name: 'act' } });
  });

  it('retries without chat_template_kwargs when the endpoint rejects it', async () => {
    let calls = 0;
    const url = await listen(
      createServer(async (req, res) => {
        const b = JSON.parse(await body(req));
        calls++;
        if (b.chat_template_kwargs) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'Unrecognized request argument: chat_template_kwargs' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '<think>hm</think>Hello' } }] }));
      }),
    );
    const llm = new NemotronLanguageModel({ apiKey: 'k', baseURL: `${url}/v1/`, models: { fast: 'm', smart: 'm' } }, log);
    const r = await llm.chat({ tier: 'fast', system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toBe('Hello');
    expect(calls).toBe(2);
  });
});

describe('NimRealtimeAsr (realtime WebSocket mock)', () => {
  it('bootstraps a session, streams base64 PCM and surfaces partial/final transcripts', async () => {
    const server = createServer(async (req, res) => {
      if (req.url === '/v1/realtime/transcription_sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 's', input_audio_transcription: { language: 'en-US', model: 'nemotron' }, client_secret: null }));
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ server });
    const received: any[] = [];
    wss.on('connection', (ws, req) => {
      expect(req.url).toBe('/v1/realtime?intent=transcription');
      ws.send(JSON.stringify({ type: 'conversation.created' }));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        received.push(m);
        if (m.type === 'transcription_session.update') ws.send(JSON.stringify({ type: 'transcription_session.updated', session: m.session }));
        if (m.type === 'input_audio_buffer.append') {
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hey ne' }));
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hey Nemo, merge 3 and 7.' }));
        }
      });
    });
    const url = await listen(server);
    const asr = new NimRealtimeAsr({ baseURL: url, language: 'en-US', boostPhrases: ['Nemo'], boost: 1.5 }, log);
    const partials: string[] = [];
    const finals: string[] = [];
    const stream = await asr.open({ onPartial: (t) => partials.push(t), onFinal: (t) => finals.push(t), onError: (e) => { throw e; } });
    stream.write(Buffer.alloc(3200));
    for (let i = 0; i < 40 && !finals.length; i++) await new Promise((r) => setTimeout(r, 25));
    stream.close();
    wss.close();
    const update = received.find((m) => m.type === 'transcription_session.update');
    expect(update.session.input_audio_format).toBe('pcm16');
    expect(update.session.input_audio_params).toEqual({ sample_rate_hz: 16000, num_channels: 1 });
    expect(update.session.word_boosting.word_boosting_list[0].phrases).toContain('Nemo');
    expect(received.some((m) => m.type === 'input_audio_buffer.append' && typeof m.audio === 'string')).toBe(true);
    expect(partials).toContain('hey ne');
    expect(finals).toEqual(['Hey Nemo, merge 3 and 7.']);
  });
});

describe('MagpieTts (synthesize_online mock)', () => {
  it('streams chunked PCM aligned on 16-bit samples', async () => {
    let form = '';
    const url = await listen(
      createServer(async (req, res) => {
        form = await body(req);
        res.writeHead(200);
        res.write(Buffer.alloc(301));
        res.end(Buffer.alloc(99));
      }),
    );
    const tts = new MagpieTts({ baseURL: url, voice: 'Magpie-Multilingual.EN-US.Aria', language: 'en-US', sampleRate: 22050 }, log);
    let total = 0;
    for await (const chunk of tts.synthesize('Hello room')) {
      expect(chunk.length % 2).toBe(0);
      total += chunk.length;
    }
    expect(total).toBe(400);
    expect(form).toContain('Magpie-Multilingual.EN-US.Aria');
    expect(form).toContain('LINEAR_PCM');
  });
});

describe('TavilyWebSearch (mock)', () => {
  it('posts the query with bearer auth and maps results', async () => {
    let auth = '';
    let sent: any;
    const url = await listen(
      createServer(async (req, res) => {
        auth = String(req.headers.authorization);
        sent = JSON.parse(await body(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [{ title: 'T', url: 'https://x.y', content: 'C', score: 0.9 }] }));
      }),
    );
    const t = new TavilyWebSearch('tvly-key', log, url);
    const r = await t.search('food waste canteen', { depth: 'fast', maxResults: 3 });
    expect(auth).toBe('Bearer tvly-key');
    expect(sent).toMatchObject({ query: 'food waste canteen', search_depth: 'fast', max_results: 3 });
    expect(r.results[0]).toMatchObject({ title: 'T', url: 'https://x.y' });
  });
});
