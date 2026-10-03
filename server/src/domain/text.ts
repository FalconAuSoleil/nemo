export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trigrams(s: string): Set<string> {
  const t = ` ${normalize(s)} `;
  const g = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return g;
}

export function similarity(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  let inter = 0;
  ga.forEach((x) => gb.has(x) && inter++);
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function slug(s: string, max = 40): string {
  return normalize(s).replace(/ /g, '-').slice(0, max) || 'x';
}

export function truncateWords(s: string, maxWords: number): string {
  const words = s.trim().split(/\s+/);
  if (words.length <= maxWords) return s.trim();
  // Cut on a word boundary and drop dangling connectors ("the", "of", ...).
  const cut = words.slice(0, maxWords);
  while (cut.length > 1 && /^(the|a|an|of|to|in|on|at|and|or|for|with|by|from|that|is|are)$/i.test(cut[cut.length - 1])) cut.pop();
  return cut.join(' ').replace(/[,;:]$/, '');
}
