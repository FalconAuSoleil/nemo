import type { Capabilities } from '@nemo/shared';
import type { LanguageModel, Logger, SpeechToText, TextToSpeech, WebSearch } from '../application/ports/index.ts';
import { ChatCompletionsLanguageModel } from './outbound/chat-completions.ts';
import { TavilyWebSearch } from './outbound/tavily.ts';
import { NimRealtimeAsr } from './outbound/nim-asr.ts';
import { MagpieTts } from './outbound/magpie-tts.ts';
import { OpenAIRealtimeAsr } from './outbound/openai-asr.ts';
import { OpenAITts } from './outbound/openai-tts.ts';
import { OpenAIWebSearch } from './outbound/openai-search.ts';
import { OfflineLanguageModel } from './fakes/offline-llm.ts';
import { OfflineWebSearch } from './fakes/offline-search.ts';

// Picks one adapter per port from the environment.
//   LLM_PROVIDER = nebius | openai | offline   (default: nebius if NEBIUS_API_KEY, else openai if OPENAI_API_KEY, else offline)
//   STT_PROVIDER = nim | openai | browser      (default: nim if NIM_ASR_URL, else browser)
//   TTS_PROVIDER = nim | openai | browser      (default: nim if NIM_TTS_URL, else browser)
//   SEARCH_PROVIDER = tavily | openai | offline (default: tavily if TAVILY_API_KEY, else openai if OPENAI_API_KEY, else offline)

export interface Adapters {
  llm: LanguageModel;
  search: WebSearch;
  asr: SpeechToText | null;
  tts: TextToSpeech | null;
  capabilities: Capabilities;
}

type Env = Record<string, string | undefined>;

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? '').trim().toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

export function buildAdapters(env: Env, log: Logger): Adapters {
  const offline = env.NEMO_OFFLINE === '1';
  const openaiKey = env.OPENAI_API_KEY ?? '';
  const openaiBase = env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const require = (ok: unknown, what: string) => {
    if (!ok) throw new Error(`${what} is required for the selected provider (see .env.example)`);
  };

  const llmProvider = offline ? 'offline' : pick(env.LLM_PROVIDER, ['nebius', 'openai', 'offline'] as const, env.NEBIUS_API_KEY ? 'nebius' : openaiKey ? 'openai' : 'offline');
  let llm: LanguageModel;
  if (llmProvider === 'nebius') {
    require(env.NEBIUS_API_KEY, 'NEBIUS_API_KEY');
    llm = new ChatCompletionsLanguageModel(
      {
        dialect: 'nemotron',
        apiKey: env.NEBIUS_API_KEY!,
        baseURL: env.NEBIUS_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1/',
        models: { fast: env.NEMO_FAST_MODEL ?? 'nvidia/Nemotron-3_5-Lightning', smart: env.NEMO_SMART_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b' },
      },
      log,
    );
  } else if (llmProvider === 'openai') {
    require(openaiKey, 'OPENAI_API_KEY');
    llm = new ChatCompletionsLanguageModel(
      {
        dialect: 'openai',
        apiKey: openaiKey,
        baseURL: openaiBase,
        models: { fast: env.OPENAI_FAST_MODEL ?? 'gpt-6-luna', smart: env.OPENAI_SMART_MODEL ?? 'gpt-6-luna' },
        // Chat Completions only allows function calling on these models with reasoning disabled.
        reasoningEffort: { fast: env.OPENAI_FAST_REASONING ?? 'none', smart: env.OPENAI_SMART_REASONING ?? 'none' },
      },
      log,
    );
  } else llm = new OfflineLanguageModel();

  const searchProvider = offline
    ? 'offline'
    : pick(env.SEARCH_PROVIDER, ['tavily', 'openai', 'offline'] as const, env.TAVILY_API_KEY ? 'tavily' : openaiKey ? 'openai' : 'offline');
  let search: WebSearch;
  if (searchProvider === 'tavily') {
    require(env.TAVILY_API_KEY, 'TAVILY_API_KEY');
    search = new TavilyWebSearch(env.TAVILY_API_KEY!, log);
  } else if (searchProvider === 'openai') {
    require(openaiKey, 'OPENAI_API_KEY');
    search = new OpenAIWebSearch({ apiKey: openaiKey, baseURL: openaiBase, model: env.OPENAI_SEARCH_MODEL ?? 'gpt-6-luna', reasoningEffort: env.OPENAI_SEARCH_REASONING ?? 'low' }, log);
  } else search = new OfflineWebSearch();

  const sttProvider = pick(env.STT_PROVIDER, ['nim', 'openai', 'browser'] as const, env.NIM_ASR_URL ? 'nim' : 'browser');
  let asr: SpeechToText | null = null;
  if (sttProvider === 'nim') {
    require(env.NIM_ASR_URL, 'NIM_ASR_URL');
    asr = new NimRealtimeAsr(
      { baseURL: env.NIM_ASR_URL!.replace(/\/$/, ''), language: env.NIM_ASR_LANGUAGE ?? 'en-US', boostPhrases: ['Nemo', 'nemo', 'Hey Nemo', 'hey nemo'], boost: Number(env.NIM_ASR_BOOST ?? 1.5) },
      log,
    );
  } else if (sttProvider === 'openai') {
    require(openaiKey, 'OPENAI_API_KEY');
    asr = new OpenAIRealtimeAsr(
      {
        apiKey: openaiKey,
        baseURL: env.OPENAI_REALTIME_URL ?? openaiBase.replace(/^http/, 'ws'),
        model: env.OPENAI_STT_MODEL ?? 'gpt-live-transcribe',
        language: env.OPENAI_STT_LANGUAGE ?? 'en',
        keywords: ['Nemo', 'SCAMPER', 'pre-mortem'],
        noiseReduction: env.OPENAI_STT_NOISE === 'near_field' ? 'near_field' : 'far_field',
      },
      log,
    );
  }

  const ttsProvider = pick(env.TTS_PROVIDER, ['nim', 'openai', 'browser'] as const, env.NIM_TTS_URL ? 'nim' : 'browser');
  let tts: TextToSpeech | null = null;
  if (ttsProvider === 'nim') {
    require(env.NIM_TTS_URL, 'NIM_TTS_URL');
    tts = new MagpieTts({ baseURL: env.NIM_TTS_URL!.replace(/\/$/, ''), voice: env.NIM_TTS_VOICE ?? 'Magpie-Multilingual.EN-US.Aria', voiceFr: env.NIM_TTS_VOICE_FR, language: 'en-US', sampleRate: 22050 }, log);
  } else if (ttsProvider === 'openai') {
    require(openaiKey, 'OPENAI_API_KEY');
    tts = new OpenAITts(
      {
        apiKey: openaiKey,
        baseURL: openaiBase,
        model: env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts',
        voice: env.OPENAI_TTS_VOICE ?? 'marin',
        instructions: env.OPENAI_TTS_INSTRUCTIONS ?? 'Warm, upbeat brainstorming facilitator. Short, friendly, natural pace.',
      },
      log,
    );
  }

  const capabilities: Capabilities = {
    asr: sttProvider,
    tts: ttsProvider,
    llm: llm.name === 'nemotron' ? 'nemotron' : llm.name === 'openai' ? 'openai' : 'offline',
    search: searchProvider,
    demo: llm.name === 'offline',
  };
  return { llm, search, asr, tts, capabilities };
}
