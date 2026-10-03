import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Logger } from './application/ports/index.ts';
import { Room } from './application/room.ts';
import { Gateway } from './adapters/inbound/gateway.ts';
import { ChatCompletionsLanguageModel } from './adapters/outbound/chat-completions.ts';
import { buildAdapters } from './adapters/providers.ts';

// Composition root: one adapter per port, chosen from the environment.

const env = process.env;
const log: Logger = {
  info: (m, x) => console.log(`[nemo] ${m}`, x ?? ''),
  warn: (m, x) => console.warn(`[nemo] WARN ${m}`, x ?? ''),
  error: (m, x) => console.error(`[nemo] ERROR ${m}`, x ?? ''),
};

const { llm, search, asr, tts, capabilities } = buildAdapters(env, log);

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, '../../client/dist');

const gateway = new Gateway(
  (code, publisher, lang) =>
    new Room(code, {
      lang,
      llm,
      search,
      tts,
      publisher,
      clock: { now: () => Date.now() },
      log,
      capabilities,
      config: {
        timeboxScale: Number(env.NEMO_TIMEBOX_SCALE ?? 1),
        coachIntervalMs: Number(env.NEMO_COACH_INTERVAL_MS ?? 25_000),
        proactivity: (env.NEMO_PROACTIVITY as 'quiet' | 'balanced' | 'active') ?? 'balanced',
        relaunchSilenceMs: Number(env.NEMO_RELAUNCH_SILENCE_MS ?? 5_000),
        style: env.NEMO_STYLE === 'calm' ? 'calm' : 'brainmaster',
        warmupMs: Number(env.NEMO_WARMUP_MS ?? 180_000),
      },
    }),
  asr,
  log,
  existsSync(staticDir) ? staticDir : undefined,
);

if (llm instanceof ChatCompletionsLanguageModel) void llm.probe();
gateway.listen(Number(env.PORT ?? 8787));
log.info(`adapters: llm=${capabilities.llm} search=${capabilities.search} asr=${capabilities.asr} tts=${capabilities.tts}`);
