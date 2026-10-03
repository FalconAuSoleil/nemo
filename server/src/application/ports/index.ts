import type { S2C } from '@nemo/shared';

// ---- Driven ports (implemented by outbound adapters) -----------------------

export type ModelTier = 'fast' | 'smart';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema (keep it flat: Nemotron's tool parser prefers it)
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ChatRequest {
  tier: ModelTier;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'required' | { name: string };
  temperature?: number;
  maxTokens?: number;
  reasoning?: boolean; // default false: latency matters
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
}

export interface LanguageModel {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
}

export interface SearchOptions {
  depth?: 'ultra-fast' | 'fast' | 'basic' | 'advanced';
  maxResults?: number;
  topic?: 'general' | 'news';
  timeRange?: 'day' | 'week' | 'month' | 'year';
  includeAnswer?: boolean;
  language?: 'en' | 'fr';
}

export interface WebSearch {
  readonly name: string;
  search(query: string, opts?: SearchOptions, signal?: AbortSignal): Promise<{ answer?: string; results: SearchResult[] }>;
  extract(urls: string[], query?: string, signal?: AbortSignal): Promise<{ url: string; content: string }[]>;
}

export interface TranscriptHandlers {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(err: Error): void;
}

export interface SpeechStream {
  write(pcm16le16k: Buffer): void;
  close(): void;
}

export interface SpeechToText {
  readonly name: string;
  open(handlers: TranscriptHandlers, opts?: { lang?: 'en' | 'fr' }): Promise<SpeechStream>;
}

export interface TextToSpeech {
  readonly name: string;
  readonly sampleRate: number;
  synthesize(text: string, signal?: AbortSignal, lang?: 'en' | 'fr'): AsyncIterable<Buffer>;
}

export interface RoomPublisher {
  /** Send to every client in the room (host and viewers). */
  broadcast(code: string, msg: S2C): void;
  /** Send to the host only (audio frames are binary). */
  toHost(code: string, msg: S2C | Buffer): void;
}

export interface Clock {
  now(): number;
}

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}
