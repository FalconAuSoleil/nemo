// Wire protocol shared by the server and the browser clients.

export type Lang = 'en' | 'fr';
export const LANGS: Lang[] = ['en', 'fr'];

export type CardKind = 'idea' | 'ai_idea' | 'fact' | 'risk' | 'question' | 'decision' | 'feature' | 'exploring';
export type Tone = 'blue' | 'pink' | 'yellow' | 'mint' | 'lilac';

export interface Card {
  id: string;
  num: number;
  clusterId: string;
  kind: CardKind;
  title: string;
  body?: string;
  sources: Source[];
  votes: number;
  ownerId: string; // 'nemo' or a sub-agent id
  createdAt: number;
}

export interface Source {
  title: string;
  url: string;
}

export interface Cluster {
  id: string;
  label: string;
  tone: Tone;
  ownerId: string;
  createdAt: number;
}

export interface Link {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface CanvasState {
  topic: string;
  clusters: Cluster[];
  cards: Card[];
  links: Link[];
}

export type Phase = 'FRAME' | 'DIVERGE' | 'CLUSTER' | 'DEEPEN' | 'CHALLENGE' | 'CONVERGE' | 'WRAPUP';
export const PHASES: Phase[] = ['FRAME', 'DIVERGE', 'CLUSTER', 'DEEPEN', 'CHALLENGE', 'CONVERGE', 'WRAPUP'];

export type NemoMode = 'idle' | 'listening' | 'thinking' | 'speaking' | 'researching';

export type AgentState = 'queued' | 'searching' | 'reading' | 'writing' | 'done' | 'stopped' | 'error';
export interface AgentStatus {
  agentId: string;
  label: string;
  theme: string;
  tone: Tone;
  state: AgentState;
  cards: number;
  searches: number;
  summary?: string;
}

export interface Popup {
  id: string;
  kind: 'fact' | 'challenge' | 'method' | 'info' | 'warning' | 'nemo'; // 'nemo': a silent line from Nemo
  title: string;
  body: string;
  why: string; // the "Why now?" explanation
  sources: Source[];
  createdAt: number;
}

export interface MethodRun {
  name: string;
  label: string;
  step: number;
  steps: string[];
  target?: number; // card number the method focuses on
  startedAt: number;
}

export interface SessionSummary {
  topic: string;
  topIdeas: { num: number; title: string; why: string }[];
  clusters: { label: string; gist: string }[];
  risks: string[];
  openQuestions: string[];
  nextSteps: string[];
  sources: Source[];
  markdown: string;
}

export interface TranscriptLine {
  id: string;
  text: string;
  final: boolean;
  speaker: 'room' | 'nemo';
  at: number;
}

export interface RoomView {
  code: string;
  lang: Lang;
  canvas: CanvasState;
  phase: Phase;
  phaseStartedAt: number;
  mode: NemoMode;
  agents: AgentStatus[];
  popups: Popup[];
  method: MethodRun | null;
  transcript: TranscriptLine[];
  summary: SessionSummary | null;
  /** Where screens should look (voice: "show me pricing", "zoom on the research", "overview"). */
  focus: { kind: 'cluster' | 'research' | 'all' | 'card' | 'tour'; ref?: string; at: number } | null;
  budget: { tokens: number; max: number };
  capabilities: Capabilities;
}

export interface Capabilities {
  asr: 'nim' | 'openai' | 'browser';
  tts: 'nim' | 'openai' | 'browser';
  llm: 'nemotron' | 'openai' | 'offline';
  search: 'tavily' | 'openai' | 'offline';
  demo: boolean;
}

// Canvas mutations broadcast to every client (the server is the only writer).
export type CanvasOp =
  | { op: 'topic'; topic: string }
  | { op: 'cluster.upsert'; cluster: Cluster }
  | { op: 'cluster.remove'; id: string }
  | { op: 'card.upsert'; card: Card }
  | { op: 'card.remove'; id: string }
  | { op: 'link.upsert'; link: Link }
  | { op: 'link.remove'; id: string };

// Server -> client
export type S2C =
  | { t: 'hello'; code: string; role: 'host' | 'viewer'; view: RoomView; v: number }
  | { t: 'canvas'; v: number; ops: CanvasOp[] }
  | { t: 'view'; patch: Partial<Omit<RoomView, 'canvas' | 'code'>> }
  | { t: 'say'; id: string; text: string; lang?: Lang } // host speaks it (browser TTS or follows audio frames)
  | { t: 'say.audio.start'; id: string; text: string; sampleRate: number }
  | { t: 'say.audio.end'; id: string }
  | { t: 'error'; message: string };

// Client -> server
export type C2S =
  | { t: 'host.create'; topic?: string; lang?: Lang }
  | { t: 'host.resume'; code: string }
  | { t: 'join'; code: string }
  | { t: 'utterance'; text: string; final: boolean } // browser ASR fallback
  | { t: 'playback'; speaking: boolean }
  | { t: 'vad'; speaking: boolean } // people are talking in the room (host mic)
  | { t: 'interrupt' } // someone talked over Nemo
  | { t: 'control'; action: 'pause' | 'resume' | 'wrapup' | 'stop_agents' | 'next_phase' | 'demo' }
  | { t: 'resync' };

export const NEMO_ID = 'nemo';
