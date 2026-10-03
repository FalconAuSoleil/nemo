import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ChatCompletionsLanguageModel } from '../src/adapters/outbound/chat-completions.ts';
import { OpenAIRealtimeAsr, upsample16to24 } from '../src/adapters/outbound/openai-asr.ts';
import { OpenAITts } from '../src/adapters/outbound/openai-tts.ts';
import { buildAdapters } from '../src/adapters/providers.ts';

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
const completion = (b: any) => ({
  id: 'x',
  object: 'chat.completion',
  created: 0,
  model: b.model,
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'act', arguments: '{"intent":"chit_chat"}' } }] } }],
});

describe('OpenAI chat dialect', () => {
  it('sends max_completion_tokens + reasoning_effort, never Nemotron-only params', async () => {
    const seen: any[] = [];
    const url = await listen(
      createServer(async (req, res) => {
        const b = JSON.parse(await body(req));
        seen.push(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completion(b)));
      }),
    );
    const llm = new ChatCompletionsLanguageModel({ dialect: 'openai', apiKey: 'k', baseURL: `${url}/v1`, models: { fast: 'gpt-6-luna', smart: 'gpt-5.6-terra' }, reasoningEffort: { fast: 'none', smart: 'none' } }, log);
    const r = await llm.chat({ tier: 'fast', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'act', description: 'd', parameters: { type: 'object' } }], toolChoice: { name: 'act' }, maxTokens: 300 });
    expect(r.toolCalls[0].name).toBe('act');
    expect(seen[0]).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 300, reasoning_effort: 'none', tool_choice: { type: 'function', function: { name: 'act' } } });
    expect(seen[0]).not.toHaveProperty('chat_template_kwargs');
    expect(seen[0]).not.toHaveProperty('max_tokens');
    expect(seen[0]).not.toHaveProperty('temperature');
  });

  it('drops a parameter the model rejects and remembers it', async () => {
    const seen: any[] = [];
    const url = await listen(
      createServer(async (req, res) => {
        const b = JSON.parse(await body(req));
        seen.push(b);
        if ('temperature' in b) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error', param: 'temperature' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completion(b)));
      }),
    );
    const llm = new ChatCompletionsLanguageModel({ dialect: 'openai', apiKey: 'k', baseURL: `${url}/v1`, models: { fast: 'm', smart: 'm' } }, log);
    await llm.chat({ tier: 'fast', system: 's', messages: [{ role: 'user', content: 'a' }] });
    await llm.chat({ tier: 'fast', system: 's', messages: [{ role: 'user', content: 'b' }] });
    expect(seen.map((b) => 'temperature' in b)).toEqual([true, false, false]);
  });
});

describe('OpenAIRealtimeAsr (realtime transcription mock)', () => {
  it('upsamples 16 -> 24 kHz', () => {
    const pcm = Buffer.alloc(3200); // 100 ms at 16 kHz
    expect(upsample16to24(pcm).length).toBe(4800); // 100 ms at 24 kHz
  });

  it('configures a transcription session, streams speech, commits on pause and surfaces transcripts', async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const received: any[] = [];
    let auth = '';
    let path = '';
    wss.on('connection', (ws, req) => {
      auth = String(req.headers.authorization);
      path = String(req.url);
      ws.send(JSON.stringify({ type: 'session.created' }));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        received.push(m);
        if (m.type === 'input_audio_buffer.commit') {
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Hey ' }));
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Nemo' }));
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Hey Nemo, look that up.' }));
        }
      });
    });
    const url = await listen(server);
    const asr = new OpenAIRealtimeAsr({ apiKey: 'sk-test', baseURL: `${url.replace('http', 'ws')}/v1`, model: 'gpt-live-transcribe', language: 'en', keywords: ['Nemo'], noiseReduction: 'far_field' }, log);
    const partials: string[] = [];
    const finals: string[] = [];
    const stream = await asr.open({ onPartial: (t) => partials.push(t), onFinal: (t) => finals.push(t), onError: (e) => { throw e; } });
    const loud = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) loud.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2);
    const quiet = Buffer.alloc(3200);
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 5; i++) stream.write(loud);
    for (let i = 0; i < 8; i++) stream.write(quiet); // 800 ms of silence -> commit
    for (let i = 0; i < 40 && !finals.length; i++) await new Promise((r) => setTimeout(r, 25));
    stream.close();
    wss.close();

    expect(auth).toBe('Bearer sk-test');
    expect(path).toBe('/v1/realtime?intent=transcription');
    const update = received.find((m) => m.type === 'session.update');
    expect(update.session.type).toBe('transcription');
    expect(update.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(update.session.audio.input.transcription).toMatchObject({ model: 'gpt-live-transcribe', languages: ['en'] });
    expect(update.session.audio.input.turn_detection).toBeNull();
    const appended = received.filter((m) => m.type === 'input_audio_buffer.append');
    expect(appended.length).toBeGreaterThan(0);
    expect(Buffer.from(appended[0].audio, 'base64').length).toBe(4800);
    expect(received.some((m) => m.type === 'input_audio_buffer.commit')).toBe(true);
    expect(partials).toContain('Hey Nemo');
    expect(finals).toEqual(['Hey Nemo, look that up.']);
  });
});

describe('OpenAITts (audio/speech mock)', () => {
  it('requests 24 kHz PCM and streams aligned chunks', async () => {
    let sent: any;
    const url = await listen(
      createServer(async (req, res) => {
        sent = JSON.parse(await body(req));
        res.writeHead(200);
        res.write(Buffer.alloc(101));
        res.end(Buffer.alloc(99));
      }),
    );
    const tts = new OpenAITts({ apiKey: 'k', baseURL: `${url}/v1`, model: 'gpt-4o-mini-tts', voice: 'marin', instructions: 'Warm.' }, log);
    let total = 0;
    for await (const c of tts.synthesize('Hello')) {
      expect(c.length % 2).toBe(0);
      total += c.length;
    }
    expect(total).toBe(200);
    expect(tts.sampleRate).toBe(24000);
    expect(sent).toEqual({ model: 'gpt-4o-mini-tts', voice: 'marin', input: 'Hello', response_format: 'pcm', instructions: 'Warm.' });
  });
});

describe('Provider selection', () => {
  it('goes all-OpenAI when asked', () => {
    const a = buildAdapters({ LLM_PROVIDER: 'openai', STT_PROVIDER: 'openai', TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk' }, log);
    expect(a.capabilities).toMatchObject({ llm: 'openai', asr: 'openai', tts: 'openai' });
  });
  it('defaults to NVIDIA when a Nebius key is present', () => {
    const a = buildAdapters({ NEBIUS_API_KEY: 'n', OPENAI_API_KEY: 'sk' }, log);
    expect(a.capabilities.llm).toBe('nemotron');
  });
  it('fails loudly when a selected provider has no key', () => {
    expect(() => buildAdapters({ TTS_PROVIDER: 'openai' }, log)).toThrow(/OPENAI_API_KEY/);
  });
});
