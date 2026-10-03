import type { Lang } from '@nemo/shared';
import type { ChatRequest, ChatResponse, LanguageModel, ToolCall } from '../../application/ports/index.ts';
import { normalize, truncateWords } from '../../domain/text.ts';
import { anglesFor, categorize, expandIdea, SPARKS } from './demo-knowledge.ts';

// Rule-based stand-in for Nemotron so the whole pipeline runs without any API key
// (offline demo, tests). It understands the same tools as the real model.

let seq = 0;
const call = (name: string, args: Record<string, unknown>): ChatResponse => ({ content: '', toolCalls: [{ id: `off-${++seq}`, name, args }] });

const IDEA_MARKERS = /\b(what if|we could|maybe|how about|idea|let's|let s|lets|should|could|why not|i think|imagine)\b/;
const METHOD_WORDS = ['scamper', 'six hats', 'thinking hats', 'reverse', '5 whys', 'five whys', 'worst idea', 'worst possible', 'starburst', 'pre-mortem', 'premortem', 'dot voting', 'crazy 8', 'mind map', 'analogies', 'first principles', 'disney', 'how might we', 'round robin', 'brainwriting'];

export class OfflineLanguageModel implements LanguageModel {
  readonly name = 'offline';

  async chat(req: ChatRequest): Promise<ChatResponse> {
    await new Promise((r) => setTimeout(r, 120));
    const tool = typeof req.toolChoice === 'object' ? req.toolChoice.name : req.tools?.[0]?.name;
    const text = req.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    const lang: Lang = /the room speaks French/.test(req.system) ? 'fr' : 'en';
    switch (tool) {
      case 'act':
        return call('act', lang === 'fr' ? actFr(text) : act(text));
      case 'coach':
        return call('coach', coach(text, lang));
      case 'fact':
        return call('fact', fact(text));
      case 'plan': {
        const theme = /Theme to explore: (.+)/.exec(text)?.[1] ?? '';
        const a = anglesFor(theme, lang);
        return call('plan', { angles: a.map((x) => x.angle), objectives: a.map((x) => x.objective) });
      }
      case 'ideas': {
        const title = /Idea #\d+: (.+)/.exec(text)?.[1] ?? 'the idea';
        return call('ideas', { ideas: expandIdea(title, lang) });
      }
      case 'summary':
        return call('summary', summary(text, lang));
      default:
        return explorerStep(req, lang);
    }
  }
}

function lastUtterances(text: string): string[] {
  const block = text.split('NEW UTTERANCES:')[1]?.split('\n\n')[0] ?? '';
  return block
    .split('\n')
    .map((l) => l.replace(/^ROOM:\s*/, '').trim())
    .filter(Boolean);
}

function nums(s: string): number[] {
  return [...s.matchAll(/#?(\d+)/g)].map((m) => Number(m[1]));
}

function act(text: string): Record<string, unknown> {
  const addressed = /NEMO ADDRESSED DIRECTLY: yes/.test(text);
  const out: Record<string, any> = { intent: 'chit_chat', add_ideas: [], risks: [], questions: [], ops_json: '[]', reply: '' };
  const ops: Record<string, unknown>[] = [];
  for (const raw of lastUtterances(text)) {
    const u = raw.replace(/^(hey |ok |okay )?(nemo|nimo|neemo)[,.!]?\s*/i, '');
    const n = normalize(u);
    let m: RegExpExecArray | null;
    if (/\b(stop|be quiet|cancel)\b/.test(n)) {
      out.stop = true;
      out.reply = 'Okay, stopping.';
      continue;
    }
    if ((m = /\b(?:brainstorm(?:ing)?|topic is|we are working on|we re working on|how might we)\b(.*)/.exec(n)) && n.length > 18 && !out.topic) {
      const hmw = /how might we (.+)/.exec(n);
      out.topic = hmw ? `How might we ${truncateWords(hmw[1], 12)}?` : truncateWords(m[1].replace(/^ (about|on|is) /, ''), 12);
      out.intent = 'idea_content';
      if (addressed) out.reply = 'Love it. Let’s go, ideas first, no judging.';
      continue;
    }
    if (/\bmerge\b/.test(n) && nums(n).length >= 2) {
      ops.push({ op: 'merge', nums: nums(n) });
      out.intent = 'canvas_command';
      out.reply = `Merged ${nums(n).join(' and ')}.`;
      continue;
    }
    if ((m = /\b(delete|remove|drop)\b/.exec(n)) && nums(n).length) {
      ops.push({ op: 'delete', num: nums(n)[0] });
      out.intent = 'canvas_command';
      out.reply = `Removed ${nums(n)[0]}.`;
      continue;
    }
    if ((m = /\brename (\d+) (?:to|as) (.+)/.exec(n))) {
      ops.push({ op: 'rename', num: Number(m[1]), title: m[2] });
      out.intent = 'canvas_command';
      out.reply = `Renamed ${m[1]}.`;
      continue;
    }
    if ((m = /\b(?:move|put) ([\d ,and#]+) (?:to|in|into|under) (.+)/.exec(n))) {
      ops.push({ op: 'move', nums: nums(m[1]), cluster: truncateWords(m[2], 4) });
      out.intent = 'canvas_command';
      out.reply = `Moved.`;
      continue;
    }
    if ((m = /\bgroup ([\d ,and#]+) (?:as|into|under) (.+)/.exec(n))) {
      ops.push({ op: 'group', nums: nums(m[1]), label: truncateWords(m[2], 4) });
      out.intent = 'canvas_command';
      out.reply = `Grouped.`;
      continue;
    }
    if (/\blink\b/.test(n) && nums(n).length >= 2) {
      ops.push({ op: 'link', from: nums(n)[0], to: nums(n)[1] });
      out.intent = 'canvas_command';
      out.reply = 'Linked.';
      continue;
    }
    if (/\bvotes?\b|\bthumbs up\b/.test(n) && nums(n).length) {
      ops.push({ op: 'vote', nums: nums(n) });
      out.intent = 'canvas_command';
      out.reply = 'Votes counted.';
      continue;
    }
    if (/\b(break down|expand|decompose)\b/.test(n) && nums(n).length) {
      ops.push({ op: 'expand', num: nums(n)[0] });
      out.intent = 'canvas_command';
      out.reply = `Breaking ${nums(n)[0]} down.`;
      continue;
    }
    if ((m = /\b(?:explore|dig into|deep dive(?: on| into)?|investigate)\b (.+)/.exec(n))) {
      out.explore_theme = m[1];
      out.intent = 'explore_request';
      out.reply = 'On it. Three agents are exploring that in parallel.';
      continue;
    }
    if ((m = /\b(?:look up|search|check|find out|google|verify)\b (.+)/.exec(n))) {
      out.research_query = m[1];
      out.intent = 'research_request';
      out.reply = 'Let me check.';
      continue;
    }
    const method = METHOD_WORDS.find((w) => n.includes(w));
    if (method && /\b(let s|lets|try|do|run|use|start)\b/.test(n)) {
      out.method = method;
      out.method_target = nums(n)[0] ?? 0;
      out.intent = 'method_request';
      continue;
    }
    if (/\b(move on|next phase|next step)\b/.test(n)) {
      out.phase = 'next';
      out.intent = 'phase_command';
      continue;
    }
    if (/\bwrap (it )?up\b/.test(n)) {
      out.phase = 'WRAPUP';
      out.intent = 'phase_command';
      continue;
    }
    if (addressed && /\?$|^(what|who|how|why|is|are|do|does|can)\b/.test(n)) {
      out.research_query = u;
      out.reply_needs_web = true;
      out.reply = 'Good question, let me check.';
      out.intent = 'ask_nemo';
      continue;
    }
    if (/\b(won t work|wont work|too expensive|risk|problem is|worried)\b/.test(n)) {
      out.risks.push(truncateWords(u.replace(/^(but|well|hmm)[, ]+/i, ''), 9));
      continue;
    }
    // Unsourced factual claims ("half of all...", "30 percent", "millions") get a quiet fact check.
    if (/\b\d+ ?(%|percent)|\bmillion\b|\bbillion\b|\b(half|most|majority|a third|a quarter) of\b|\bi read\b|\bstudies show\b/.test(n)) {
      out.research_query = u.replace(/^(i read that|i read|apparently)\s+(like\s+)?/i, '');
      if (!IDEA_MARKERS.test(n)) continue;
    }
    const methodRunning = /running method:/.test(text);
    if ((IDEA_MARKERS.test(n) || methodRunning) && n.split(' ').length >= 4) {
      const title = u
        .replace(/^(so|and|ok|okay|well|yeah|um|uh|meanwhile|also)[, ]+/i, '')
        .replace(/^(what if we|what if|we could also|we could|maybe we could|maybe|how about|i think we should|we should|let['’]s|why not)\s+/i, '')
        .replace(/[.?!]+$/, '');
      out.add_ideas.push(truncateWords(title.charAt(0).toUpperCase() + title.slice(1), 12));
      out.intent = 'idea_content';
      continue;
    }
    if (/\?$/.test(u.trim())) out.questions.push(truncateWords(u, 10));
  }
  out.idea_themes = out.add_ideas.map((t: string) => categorize(t, 'en') ?? '');
  out.speak = /\b(tell us|tell me|say it|out loud|answer me)\b/i.test(lastUtterances(text).join(' '));
  out.ops_json = JSON.stringify(ops);
  if (!addressed && !ops.length && !out.stop) out.reply = '';
  return out;
}

// ---- French rules -------------------------------------------------------------

const IDEA_MARKERS_FR = /\b(et si|on pourrait|peut etre|pourquoi pas|il faudrait|on devrait|je propose|imaginons|on peut|ce serait bien)\b/;
const METHOD_WORDS_FR = ['scamper', 'six chapeaux', 'chapeaux', 'inverse', '5 pourquoi', 'cinq pourquoi', 'pire idee', 'pre mortem', 'vote a points', 'carte mentale', 'analogies', 'premiers principes', 'disney', 'tour de table', 'brainwriting', 'starbursting'];

function actFr(text: string): Record<string, unknown> {
  const addressed = /NEMO ADDRESSED DIRECTLY: yes/.test(text);
  const out: Record<string, any> = { intent: 'chit_chat', add_ideas: [], risks: [], questions: [], ops_json: '[]', reply: '' };
  const ops: Record<string, unknown>[] = [];
  const methodRunning = /running method:/.test(text);
  for (const raw of lastUtterances(text)) {
    const u = raw.replace(/^(h[ée] |ok |dis )?(nemo|nimo|neemo)[,.!]?\s*/i, '');
    const n = normalize(u);
    let m: RegExpExecArray | null;
    if (/\b(stop|arrete|tais toi|silence|annule)\b/.test(n)) {
      out.stop = true;
      out.reply = 'D’accord, j’arrête.';
      continue;
    }
    if (/\b(on reflechit|on brainstorme|on travaille sur|le sujet c est|comment pourrions nous)\b/.test(n) && n.length > 18 && !out.topic) {
      const after = u.split(/comment/i)[1];
      out.topic = after ? `Comment ${truncateWords(after.replace(/[.?!]+$/, ''), 12)} ?` : truncateWords(u, 12);
      out.intent = 'idea_content';
      if (addressed) out.reply = 'Super. On y va : d’abord des idées, sans juger.';
      continue;
    }
    if (/\bfusionne\b/.test(n) && nums(n).length >= 2) {
      ops.push({ op: 'merge', nums: nums(n) });
      out.intent = 'canvas_command';
      out.reply = `Fusionné ${nums(n).join(' et ')}.`;
      continue;
    }
    if (/\b(supprime|enleve|retire)\b/.test(n) && nums(n).length) {
      ops.push({ op: 'delete', num: nums(n)[0] });
      out.intent = 'canvas_command';
      out.reply = `${nums(n)[0]} supprimée.`;
      continue;
    }
    if ((m = /\brenomme (?:la )?(\d+) en (.+)/.exec(n))) {
      ops.push({ op: 'rename', num: Number(m[1]), title: m[2] });
      out.intent = 'canvas_command';
      out.reply = `${m[1]} renommée.`;
      continue;
    }
    if ((m = /\b(?:deplace|mets) (?:la |les )?([\d ,et]+) (?:dans|sous|en) (.+)/.exec(n))) {
      ops.push({ op: 'move', nums: nums(m[1]), cluster: truncateWords(m[2], 4) });
      out.intent = 'canvas_command';
      out.reply = 'C’est déplacé.';
      continue;
    }
    if ((m = /\bregroupe (?:la |les )?([\d ,et]+) (?:dans|sous|en) (.+)/.exec(n))) {
      ops.push({ op: 'group', nums: nums(m[1]), label: truncateWords(m[2], 4) });
      out.intent = 'canvas_command';
      out.reply = 'C’est regroupé.';
      continue;
    }
    if (/\b(relie|lie)\b/.test(n) && nums(n).length >= 2) {
      ops.push({ op: 'link', from: nums(n)[0], to: nums(n)[1] });
      out.intent = 'canvas_command';
      out.reply = 'C’est relié.';
      continue;
    }
    if (/\bvote/.test(n) && nums(n).length) {
      ops.push({ op: 'vote', nums: nums(n) });
      out.intent = 'canvas_command';
      out.reply = 'Votes comptés.';
      continue;
    }
    if (/\b(decompose|detaille|developpe)\b/.test(n) && nums(n).length) {
      ops.push({ op: 'expand', num: nums(n)[0] });
      out.intent = 'canvas_command';
      out.reply = `Je décompose la ${nums(n)[0]}.`;
      continue;
    }
    if ((m = /\b(?:explore|creuse|approfondis)\b (.+)/.exec(n))) {
      out.explore_theme = m[1].replace(/^(les|la|le|l) /, '');
      out.intent = 'explore_request';
      out.reply = 'C’est parti. Trois agents explorent ça en parallèle.';
      continue;
    }
    if ((m = /\b(?:cherche|verifie|regarde|trouve)\b (.+)/.exec(n))) {
      out.research_query = m[1];
      out.intent = 'research_request';
      out.reply = 'Je regarde.';
      continue;
    }
    const method = METHOD_WORDS_FR.find((w) => n.includes(w)) ?? METHOD_WORDS.find((w) => n.includes(w));
    if (method && /\b(on fait|faisons|lance|essayons|on tente|on essaie)\b/.test(n)) {
      out.method = method;
      out.method_target = nums(n)[0] ?? 0;
      out.intent = 'method_request';
      continue;
    }
    if (/\b(passe a la suite|etape suivante|on avance|on passe a la suite)\b/.test(n)) {
      out.phase = 'next';
      out.intent = 'phase_command';
      continue;
    }
    if (/\b(conclus|on conclut|fais la synthese|on termine)\b/.test(n)) {
      out.phase = 'WRAPUP';
      out.intent = 'phase_command';
      continue;
    }
    if (addressed && /\?$|^(qu est ce|quel|quelle|combien|comment|pourquoi|est ce)\b/.test(n)) {
      out.research_query = u;
      out.reply_needs_web = true;
      out.reply = 'Bonne question, je regarde.';
      out.intent = 'ask_nemo';
      continue;
    }
    if (/\b(marchera pas|marche pas|trop cher|le probleme c est|risque|j ai peur)\b/.test(n)) {
      out.risks.push(truncateWords(u.replace(/^(mais|bon|franchement)[, ]+/i, ''), 10));
      continue;
    }
    if (/\b\d+ ?(%|pour cent)|\bmillion|\bmilliard|\b(la moitie|la plupart|un tiers|un quart) de\b|\bj ai lu\b/.test(n)) {
      out.research_query = u.replace(/^j['’]ai lu que\s+/i, '');
      if (!IDEA_MARKERS_FR.test(n)) continue;
    }
    if ((IDEA_MARKERS_FR.test(n) || methodRunning) && n.split(' ').length >= 4) {
      const title = u
        .replace(/^(en attendant|franchement|bon|alors|aussi)[, ]+/i, '')
        .replace(/^(et si on|et si|on pourrait|peut-être|peut etre|pourquoi pas|il faudrait|on devrait|je propose de|imaginons|on peut)\s+/i, '')
        .replace(/[.?!]+$/, '');
      out.add_ideas.push(truncateWords(title.charAt(0).toUpperCase() + title.slice(1), 12));
      out.intent = 'idea_content';
      continue;
    }
    if (/\?$/.test(u.trim())) out.questions.push(truncateWords(u, 10));
  }
  out.idea_themes = out.add_ideas.map((t: string) => categorize(t, 'fr') ?? '');
  out.speak = /\b(dis[- ]nous|dis[- ]moi|r[ée]ponds|explique[- ]nous|[àa] voix haute)\b/i.test(lastUtterances(text).join(' '));
  out.ops_json = JSON.stringify(ops);
  if (!addressed && !ops.length && !out.stop) out.reply = '';
  return out;
}

function coach(text: string, lang: Lang = 'en'): Record<string, unknown> {
  const forced = /entered CLUSTER/.test(text);
  const stall = /detected_stall: (.+) -> suggested method (\w+)/.exec(text);
  const humanIdeas = Number(/human_ideas=(\d+)/.exec(text)?.[1] ?? 0);

  // Cards currently sitting in the "Unsorted" cluster.
  const unsorted: { num: number; title: string }[] = [];
  let inUnsorted = false;
  for (const line of (text.split('CANVAS:')[1] ?? '').split('\n')) {
    const cl = /^\[cluster "(.+)"\]/.exec(line);
    if (cl) inUnsorted = cl[1] === 'Unsorted';
    const m = /^\s+#(\d+) \((idea|ai_idea|question)[^)]*\) (.+)/.exec(line);
    if (m && inUnsorted) unsorted.push({ num: Number(m[1]), title: m[3] });
  }

  if (forced || unsorted.length >= 4) {
    const groups = new Map<string, number[]>();
    for (const c of unsorted) {
      const label = categorize(c.title, lang) ?? (forced ? (lang === 'fr' ? 'Autres idées' : 'Other ideas') : undefined);
      if (!label) continue;
      groups.set(label, [...(groups.get(label) ?? []), c.num]);
    }
    if (groups.size) {
      const all = [...groups.entries()].map(([label, nums]) => ({ label, nums }));
      return {
        action: 'cluster',
        why: lang === 'fr' ? `${unsorted.length} idées à trier.` : `${unsorted.length} fresh ideas to sort.`,
        groups_json: JSON.stringify(all),
        say: forced ? (lang === 'fr' ? 'J’ai trié le tableau par thèmes. On vérifie ?' : 'I sorted the board into themes. Check them?') : '',
      };
    }
  }
  if (humanIdeas >= 8 && !text.includes("Nemo's sparks") && !text.includes('Étincelles de Nemo')) {
    return {
      action: 'ai_ideas',
      why: lang === 'fr' ? `${humanIdeas} idées humaines ; un angle reste vide.` : `${humanIdeas} human ideas so far; one angle is still empty.`,
      ideas: SPARKS[lang],
    };
  }
  if (stall) return { action: 'method', method: stall[2], why: stall[1] };
  return { action: 'none', why: lang === 'fr' ? 'Le groupe est lancé.' : 'The group is flowing.' };
}

function fact(text: string): Record<string, unknown> {
  const first = /\[0\] (.+?) \((https?:[^)]+)\)\n([^\n]+)/.exec(text);
  const title = first ? truncateWords(first[1], 10) : 'No clear finding';
  const body = first ? truncateWords(first[3].replace(/ \(offline demo data\)$/, ''), 35) : '';
  return { title, body, verdict: /check|verify|true/.test(text) ? 'nuanced' : 'info', spoken: truncateWords(body || title, 20), source_indexes: [0] };
}

function summary(text: string, lang: Lang = 'en'): Record<string, unknown> {
  const fr = lang === 'fr';
  const cards = [...text.matchAll(/#(\d+) \((idea|ai_idea)(?: votes=(\d+))?\) (.+)/g)]
    .map((m) => ({ num: Number(m[1]), votes: Number(m[3] ?? 0), title: m[4] }))
    .sort((a, b) => b.votes - a.votes);
  const clusters = [...text.matchAll(/\[cluster "(.+?)"\]/g)].map((m) => `${m[1]} | `);
  const risks = [...text.matchAll(/#\d+ \(risk[^)]*\) (.+)/g)].map((m) => m[1]);
  const questions = [...text.matchAll(/#\d+ \(question[^)]*\) (.+)/g)].map((m) => m[1]);
  return {
    top_ideas: cards.slice(0, 3).map((c) => `#${c.num} | ${c.title} | ${c.votes ? `${c.votes} vote${c.votes > 1 ? 's' : ''}` : fr ? 'fort soutien dans la salle' : 'strong support in the room'}`),
    clusters,
    risks: risks.slice(0, 5),
    open_questions: questions.slice(0, 5),
    next_steps: cards.slice(0, 3).map((c) => (fr ? `Prototyper la #${c.num} avec une équipe ce mois-ci` : `Prototype #${c.num} with one team this month`)),
    spoken: cards[0]
      ? fr
        ? `Le choix numéro un, c’est la ${cards[0].num} : ${cards[0].title}. La synthèse est à l’écran.`
        : `Top pick is number ${cards[0].num}, ${cards[0].title}. Summary is on screen.`
      : fr
        ? 'La synthèse est à l’écran.'
        : 'Summary is on screen.',
  };
}

function explorerStep(req: ChatRequest, lang: Lang = 'en'): ChatResponse {
  const toolMsgs = req.messages.filter((m) => m.role === 'tool');
  const brief = req.messages[0] && 'content' in req.messages[0] ? req.messages[0].content : '';
  const theme = /Theme: (.+)/.exec(brief)?.[1] ?? 'the theme';
  const angle = /Your angle: (.+)/.exec(brief)?.[1] ?? 'research';
  const objective = /Objective: (.+)/.exec(brief)?.[1] ?? '';
  const id = () => `off-${++seq}`;
  if (toolMsgs.length === 0) return { content: '', toolCalls: [{ id: id(), name: 'web_search', args: { query: `${angle} ${objective} ${theme}` } }] };

  let results: { title: string; url: string; content: string }[] = [];
  try {
    const first = toolMsgs[0];
    results = JSON.parse(first.role === 'tool' ? first.content : '[]');
  } catch {
    /* ignore */
  }
  // Skip what is already on the canvas or already written by this agent.
  const written = req.messages.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).filter((c) => c.name === 'add_card').map((c) => String(c.args.source_url)) : []));
  const onCanvas = normalize(/Already on the canvas[^:]*: (.+)/.exec(brief)?.[1] ?? '');
  const fresh = results.filter((r) => !written.includes(r.url) && !onCanvas.includes(normalize(r.title)));
  const cards = written.length;
  if (cards >= 2 || !fresh.length || toolMsgs.length > 4) {
    return { content: '', toolCalls: [{ id: id(), name: 'finish', args: { summary: lang === 'fr' ? `${cards} trouvaille${cards > 1 ? 's' : ''} sur ${angle.toLowerCase()}.` : `${cards} finding${cards === 1 ? '' : 's'} on ${angle.toLowerCase()}.` } }] };
  }
  const r = fresh[0];
  return {
    content: '',
    toolCalls: [{ id: id(), name: 'add_card', args: { title: truncateWords(r.title, 9), detail: truncateWords(r.content.replace(/ \(offline demo data\)$/, ''), 26), source_url: r.url, source_title: r.title } }],
  };
}
