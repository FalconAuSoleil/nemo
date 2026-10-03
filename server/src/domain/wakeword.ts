import { normalize } from './text.ts';

// ASR often mangles "Nemo". Accept close variants, but not "demo"/"memo" mid-sentence.
const VARIANTS = ['nemo', 'nemos', 'nimo', 'neemo', 'nemmo', 'nemu', 'neemu', 'nemoh', 'nymo', 'nemow'];
const RISKY = ['demo', 'memo', 'lemo', 'emo', 'nino', 'neymar'];

export interface WakeMatch {
  addressed: boolean;
  command: string; // utterance with the wake word stripped
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function isWake(token: string, position: number): boolean {
  if (VARIANTS.includes(token)) return true;
  if (RISKY.includes(token)) return position <= 1; // only "demo, ..." / "hey memo ..." at the start
  return token.length >= 4 && token.length <= 5 && token.startsWith('n') && levenshtein(token, 'nemo') <= 1;
}

export function detectWakeWord(text: string): WakeMatch {
  const tokens = normalize(text).split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (isWake(tokens[i], i)) {
      const rest = tokens.filter((_, k) => k !== i && !(k === i - 1 && ['hey', 'ok', 'okay', 'hi', 'yo', 'he', 'dis', 'salut'].includes(tokens[k])));
      return { addressed: true, command: rest.join(' ') };
    }
  }
  return { addressed: false, command: text };
}
