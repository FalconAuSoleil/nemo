import type { Lang, Phase } from '@nemo/shared';

// Everything Nemo says or writes on its own (outside model output), per language.

type Params = Record<string, string | number>;
const fill = (s: string, p: Params = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));

const PHRASES = {
  greetTopic: { en: "Hi, I'm Nemo. Let's frame it: {topic}", fr: 'Salut, je suis Nemo. On cadre le sujet : {topic}' },
  greetLongTopic: { en: "Hi, I'm Nemo. Got the full brief. Let's go: ideas first.", fr: 'Salut, je suis Nemo. J’ai bien le sujet complet. On y va : d’abord des idées.' },
  greet: { en: "Hi, I'm Nemo. What are we brainstorming today?", fr: 'Salut, je suis Nemo. Sur quoi on réfléchit aujourd’hui ?' },
  lostThread: { en: 'Sorry, I lost my train of thought. Say that again?', fr: 'Pardon, j’ai perdu le fil. Tu peux répéter ?' },
  stopping: { en: 'Okay, stopping.', fr: 'D’accord, j’arrête.' },
  exploring: { en: 'On it. {n} agents are exploring that in parallel.', fr: 'C’est parti. {n} agents explorent ça en parallèle.' },
  nothingFound: { en: "I couldn't find anything solid on that.", fr: 'Je n’ai rien trouvé de solide là-dessus.' },
  searchFailed: { en: 'My web search failed, sorry.', fr: 'Ma recherche web a échoué, désolé.' },
  quickCheck: { en: 'Quick check: {text}', fr: 'Petite vérification : {text}' },
  askedLookup: { en: 'You asked me to look this up.', fr: 'Vous m’avez demandé de chercher ça.' },
  claimCheck: { en: 'Someone made a factual claim: "{claim}".', fr: 'Une affirmation à vérifier : « {claim} ».' },
  agentsDone: { en: '{n} agents finished exploring {theme}. {first}', fr: '{n} agents ont fini d’explorer {theme}. {first}' },
  explorationDone: { en: 'Exploration done: {theme}', fr: 'Exploration terminée : {theme}' },
  askedExplore: { en: 'You asked me to explore this theme.', fr: 'Vous m’avez demandé d’explorer ce thème.' },
  tryMethod: { en: 'Want to try {method}? Just say yes.', fr: 'On tente {method} ? Dites juste oui.' },
  sayMethod: { en: 'Say "Nemo, let\'s do {method}".', fr: 'Dites « Nemo, on fait {method} ».' },
  proposePhase: { en: 'Ready to move to {phase}? Say not yet to stay.', fr: 'On passe à l’étape {phase} ? Dites « pas encore » pour rester.' },
  stayHint: { en: 'Say "not yet" to stay.', fr: 'Dites « pas encore » pour rester.' },
  movingTo: { en: 'Moving to {phase}.', fr: 'On passe à l’étape {phase}.' },
  staying: { en: 'Sure, staying here a bit longer.', fr: 'OK, on reste encore un peu ici.' },
  movingOn: { en: 'Moving on.', fr: 'On avance.' },
  wrappingUp: { en: 'Wrapping up.', fr: 'On conclut.' },
  summaryOnScreen: { en: 'Summary is on screen. Great session.', fr: 'La synthèse est à l’écran. Belle session.' },
  methodDone: { en: '{method} done. Nice work.', fr: '{method} terminé. Bien joué.' },
  merged: { en: 'Merged {nums}.', fr: 'Fusionné {nums}.' },
  renamed: { en: 'Renamed {num}.', fr: '{num} renommée.' },
  removed: { en: 'Removed {num}.', fr: '{num} supprimée.' },
  moved: { en: 'Moved to {cluster}.', fr: 'Déplacé dans {cluster}.' },
  grouped: { en: 'Grouped as {label}.', fr: 'Regroupé sous {label}.' },
  linked: { en: 'Linked.', fr: 'C’est relié.' },
  votes: { en: 'Votes counted.', fr: 'Votes comptés.' },
  renamedCluster: { en: 'Renamed the cluster.', fr: 'Thème renommé.' },
  breakingDown: { en: 'Breaking {num} down.', fr: 'Je décompose la {num}.' },
  divergeTitle: { en: 'Diverge mode', fr: 'Mode divergence' },
  divergeBody: { en: 'Quantity first, no judging yet.', fr: 'La quantité d’abord, on ne juge pas encore.' },
  clustered: { en: 'Ideas clustered', fr: 'Idées regroupées' },
  clusteredBody: { en: '{n} themes. Say "move 7 to Pricing" to fix anything.', fr: '{n} thèmes. Dites « déplace la 7 dans Prix » pour corriger.' },
  devil: { en: 'Devil’s advocate', fr: 'Avocat du diable' },
  blindSpot: { en: 'Blind spot', fr: 'Angle mort' },
  tryLabel: { en: 'Try: {method}', fr: 'À tester : {method}' },
  nextLabel: { en: 'Next: {phase}', fr: 'Étape suivante : {phase}' },
  exploringCard: { en: 'Exploring {angle}…', fr: 'Exploration : {angle}…' },
  findings: { en: '{n} findings on {angle}', fr: '{n} trouvailles sur {angle}' },
  sparks: { en: "Nemo's sparks", fr: 'Étincelles de Nemo' },
  bestIdeas: { en: 'Best ideas', fr: 'Meilleures idées' },
  featuresOf: { en: '{concept} · features', fr: '{concept} · fonctionnalités' },
  parking: { en: 'Parking lot', fr: 'En attente' },
  research: { en: 'Research', fr: 'Recherches' },
  blindSpots: { en: 'Blind spots', fr: 'Angles morts' },
} satisfies Record<string, Record<Lang, string>>;

export type PhraseKey = keyof typeof PHRASES;

export function t(lang: Lang, key: PhraseKey, params?: Params): string {
  return fill(PHRASES[key][lang] ?? PHRASES[key].en, params);
}

const PHASE_NAMES: Record<Lang, Record<Phase, string>> = {
  en: { FRAME: 'framing', DIVERGE: 'diverging', CLUSTER: 'clustering', DEEPEN: 'deepening', CHALLENGE: 'challenge', CONVERGE: 'converging', WRAPUP: 'wrap-up' },
  fr: { FRAME: 'cadrage', DIVERGE: 'divergence', CLUSTER: 'regroupement', DEEPEN: 'approfondissement', CHALLENGE: 'remise en question', CONVERGE: 'convergence', WRAPUP: 'conclusion' },
};

export function phaseName(lang: Lang, phase: Phase): string {
  return PHASE_NAMES[lang][phase];
}

/** Instruction appended to every model prompt so cards and speech follow the room's language. */
export function languageRule(lang: Lang): string {
  return lang === 'fr'
    ? 'LANGUAGE: the room speaks French. Write every card title, detail, question, reply and spoken line in natural French (tutoiement collectif, "vous" for the group). Keep proper names as is.'
    : 'LANGUAGE: the room speaks English. Write everything in English.';
}

// French versions of the facilitation scripts (same order as playbook.json).
export const METHOD_LABELS_FR: Record<string, string> = {
  HMW: 'Comment pourrions-nous',
  mind_map: 'Carte mentale',
  affinity_kj: 'Regroupement par affinités',
  scamper: 'SCAMPER',
  six_hats: 'Six chapeaux',
  reverse: 'Brainstorming inversé',
  '5_whys': '5 pourquoi',
  oral_brainwriting: 'Brainwriting silencieux',
  starbursting: 'Starbursting',
  round_robin: 'Tour de table',
  worst_idea: 'Pire idée possible',
  analogies: 'Analogies',
  first_principles: 'Premiers principes',
  premortem: 'Pré-mortem',
  dot_voting_voice: 'Vote à points',
  impact_effort: 'Impact / effort',
  disney: 'Méthode Disney',
  lotus: 'Fleur de lotus',
};

export const METHOD_STEPS_FR: Record<string, string[]> = {
  HMW: ['Quel problème on résout aujourd’hui ?', 'Trois formulations à l’écran. Laquelle colle ?', 'Trop large ? Trop étroit ?', 'C’est validé : comment pourrions-nous… ?'],
  mind_map: ['On construit la carte autour du sujet. Lancez des branches.', 'Cette branche est maigre. Une idée ?'],
  affinity_kj: ['J’ai regroupé les cartes en thèmes. On vérifie ?', 'Une carte mal placée ? Dites « déplace la 7 dans B ».', 'Un nom pour ce thème ?'],
  scamper: [
    'SCAMPER sur #{n}. Sept angles rapides.',
    'Substituer : qu’est-ce qu’on pourrait remplacer ?',
    'Combiner : avec quelle autre carte ?',
    'Adapter : qui a déjà résolu ça ailleurs ?',
    'Modifier : on l’agrandit ou on la réduit ?',
    'Proposer un autre usage ?',
    'Éliminer : quelle partie enlever ?',
    'Réorganiser ou inverser ?',
  ],
  six_hats: ['Tout le monde porte le même chapeau. Blanc : que des faits.', 'Rouge : vos intuitions.', 'Noir : les risques.', 'Jaune : les bénéfices.', 'Vert : de nouvelles options.', 'Bleu : alors, on décide quoi ?'],
  reverse: ['On inverse : comment garantir l’échec ?', 'Lesquelles fait-on déjà ?', 'Retournez les trois pires en solutions.'],
  '5_whys': ['Pourquoi ce problème arrive-t-il ?', 'Et pourquoi ça ?', 'On dirait une cause racine. D’accord ?'],
  oral_brainwriting: ['Tour silencieux. Papier, trois idées, trois minutes.', 'Stop. Gardez vos deux meilleures.', 'Lisez vos deux idées, chacun son tour.'],
  starbursting: ['Que des questions, pas de réponses. Qui utiliserait #{n} ?', 'Quoi ? Où ? Quand ? Pourquoi ? Comment ?', 'Quelles questions je peux chercher maintenant ?'],
  round_robin: ['Tour rapide. Une idée chacun, on peut passer.'],
  worst_idea: ['Allons-y franchement : la pire idée possible ?', 'Qu’est-ce qu’il y a de bon, en secret, là-dedans ?'],
  analogies: ['Comment la nature résoudrait ça ?', 'Comment un autre secteur ferait ?'],
  first_principles: ['Qu’est-ce qui est vraiment vrai ?', 'Lesquelles sont juste des hypothèses ?', 'En partant des faits seulement, qu’est-ce qui est possible ?'],
  premortem: ['On est dans un an. #{n} a échoué. Pourquoi ?', 'Les trois causes principales ?', 'Une parade pour chacune ?'],
  dot_voting_voice: ['On vote. Trois votes chacun.', 'Dites « vote pour 4, 9 et 12 ».', 'Voici le top.'],
  impact_effort: ['#{n} : fort impact ? Peu d’effort ?', 'Dites « déplace la 9 à droite » pour ajuster.'],
  disney: ['Rêveur : sans limites. La version de rêve ?', 'Réaliste : qu’est-ce qu’il faudrait ?', 'Critique, gentiment : qu’est-ce qui coince ?'],
  lotus: ['Huit thèmes autour du sujet. Allez-y.', 'Choisissez deux thèmes à développer.', 'Huit idées pour ce thème.'],
};
