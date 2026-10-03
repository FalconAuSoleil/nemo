// `npm run check`: verifies every real integration selected by .env.
import { ACT_TOOL, BRAIN_SYSTEM } from '../application/agents/prompts.ts';
import { ChatCompletionsLanguageModel } from '../adapters/outbound/chat-completions.ts';
import { buildAdapters } from '../adapters/providers.ts';

const env = process.env;
const log = { info: (m: string) => console.log(`   ${m}`), warn: (m: string, x?: unknown) => console.log(`   WARN ${m}`, x ?? ''), error: (m: string, x?: unknown) => console.log(`   ERROR ${m}`, x ?? '') };
let failures = 0;

async function step(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`OK   ${name} (${Date.now() - t} ms) ${out}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${String((err as Error).message ?? err)}`);
  }
}

const { llm, search, asr, tts, capabilities } = buildAdapters(env, log);
console.log(`Providers: llm=${capabilities.llm} search=${capabilities.search} stt=${capabilities.asr} tts=${capabilities.tts}\n`);

if (llm instanceof ChatCompletionsLanguageModel) {
  await step(`${llm.name} models`, async () => {
    if (!(await llm.probe())) throw new Error('cannot list models');
    return '';
  });
  for (const tier of ['fast', 'smart'] as const) {
    await step(`${llm.name} ${tier} tool call`, async () => {
      const r = await llm.chat({
        tier,
        system: BRAIN_SYSTEM,
        messages: [{ role: 'user', content: 'PHASE: DIVERGE\n\nCANVAS:\n#1 (idea) Pre-order lunch in an app\n#2 (idea) Sell leftovers cheap\n\nNEW UTTERANCES:\nROOM: Hey Nemo, merge 1 and 2, and what if we compost leftovers?\n\nNEMO ADDRESSED DIRECTLY: yes' }],
        tools: [ACT_TOOL],
        toolChoice: { name: 'act' },
        temperature: 0.3,
        maxTokens: 700,
      });
      if (!r.toolCalls.length) throw new Error(`no tool call, content: ${r.content.slice(0, 120)}`);
      return JSON.stringify(r.toolCalls[0].args).slice(0, 220);
    });
  }
} else console.log('SKIP LLM (offline)');

if (search.name !== 'offline') {
  await step(`Web search (${search.name})`, async () => {
    const r = await search.search('office cafeteria food waste statistics', { depth: 'fast', maxResults: 3 });
    return r.results.map((x) => x.url).join(' ');
  });
} else console.log('SKIP web search (offline)');

if (tts) {
  await step(`TTS (${tts.name})`, async () => {
    let bytes = 0;
    for await (const c of tts.synthesize("Hi, I'm Nemo.")) bytes += c.length;
    if (!bytes) throw new Error('no audio');
    return `${(bytes / 2 / tts.sampleRate).toFixed(2)} s of audio`;
  });
} else console.log('SKIP TTS (browser voice)');

if (asr) {
  await step(`STT (${asr.name}) session`, async () => {
    let error: Error | null = null;
    const s = await asr.open({ onPartial() {}, onFinal() {}, onError: (e) => (error = e) });
    // 1.5 s of a quiet tone: enough to exercise the audio path.
    const pcm = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), i * 2);
    for (let i = 0; i < 15; i++) s.write(pcm);
    await new Promise((r) => setTimeout(r, 3000));
    s.close();
    if (error) throw error;
    return 'session opened and accepted audio';
  });
} else console.log('SKIP STT (browser recognition)');

process.exit(failures ? 1 : 0);
