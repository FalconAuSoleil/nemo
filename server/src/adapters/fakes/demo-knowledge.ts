import type { Lang } from '@nemo/shared';
import { normalize } from '../../domain/text.ts';

// Domain knowledge used only by the offline adapters, so the scripted demo
// (food waste in an office cafeteria) shows rich structure without any API.
// With real keys, the language model and the web search produce all of this live.

type L<T> = Record<Lang, T>;

interface Category {
  label: L<string>;
  keywords: string[]; // normalized, both languages
}

const CATEGORIES: Category[] = [
  {
    label: { en: 'Pre-ordering & forecasting', fr: 'Pré-commande & prévision' },
    keywords: ['pre order', 'preorder', 'order', 'app', 'forecast', 'booking', 'book', 'calendar', 'qr', 'attendance', 'reserve', 'pre command', 'commande', 'appli', 'reserv', 'calendrier', 'prevision'],
  },
  {
    label: { en: 'Portions & menu', fr: 'Portions & menu' },
    keywords: ['portion', 'menu', 'plate', 'seconds', 'recipe', 'weather', 'smaller', 'size', 'buffet', 'dish', 'chef', 'rab', 'meteo', 'plat', 'recette', 'cuisin'],
  },
  {
    label: { en: 'Leftovers & redistribution', fr: 'Restes & redistribution' },
    keywords: ['leftover', 'sell', 'donate', 'surplus', 'takeaway', 'take away', 'cheap', 'discount', 'charity', 'fridge', 'box', 'restes', 'vendre', 'donner', 'invendu', 'association', 'emporter'],
  },
  {
    label: { en: 'Compost & circularity', fr: 'Compost & circularité' },
    keywords: ['compost', 'herb', 'garden', 'roof', 'biogas', 'soil', 'bokashi', 'digest', 'herbes', 'toit', 'jardin', 'biogaz'],
  },
  {
    label: { en: 'Nudges & gamification', fr: 'Incitations & jeu' },
    keywords: ['leaderboard', 'points', 'team', 'nudge', 'badge', 'challenge', 'game', 'reward', 'trophy', 'competition', 'classement', 'equipe', 'trophee', 'defi', 'recompense'],
  },
  {
    label: { en: 'Measure & data', fr: 'Mesure & données' },
    keywords: ['scale', 'measure', 'track', 'dashboard', 'camera', 'weigh', 'data', 'sensor', 'counter', 'report', 'balance', 'mesur', 'tableau de bord', 'pes', 'donnee', 'compteur'],
  },
];

export function categorize(title: string, lang: Lang = 'en'): string | undefined {
  const n = ` ${normalize(title)} `;
  let best: { label: string; hits: number } | undefined;
  for (const c of CATEGORIES) {
    const hits = c.keywords.filter((k) => n.includes(` ${k}`)).length;
    if (hits && (!best || hits > best.hits)) best = { label: c.label[lang], hits };
  }
  return best?.label;
}

const EXPANSIONS: { keywords: string[]; ideas: L<string[]> }[] = [
  {
    keywords: ['leaderboard', 'team', 'points', 'game', 'classement', 'equipe'],
    ideas: {
      en: ['Monthly trophy for the least-waste team', 'Live waste counter at the tray return', 'Bonus points for empty plates'],
      fr: ['Trophée mensuel de l’équipe la moins gaspilleuse', 'Compteur de gaspillage en direct au retour plateaux', 'Points bonus pour les assiettes vides'],
    },
  },
  {
    keywords: ['pre order', 'order', 'app', 'qr', 'pre command', 'commande', 'appli'],
    ideas: {
      en: ['Order window closes at 10 am', 'One-tap "my usual" order', 'Lunch reminder in the team calendar'],
      fr: ['Commandes closes à 10 h', 'Commande « comme d’habitude » en un clic', 'Rappel déjeuner dans le calendrier d’équipe'],
    },
  },
  {
    keywords: ['portion', 'seconds', 'plate', 'rab'],
    ideas: {
      en: ['Small, medium, large plate sizes', 'Free refill station for sides', 'Show portion weight on the menu'],
      fr: ['Trois tailles d’assiette', 'Bar à accompagnements à volonté', 'Grammage affiché sur le menu'],
    },
  },
  {
    keywords: ['leftover', 'sell', 'surplus', 'cheap', 'restes', 'vendre', 'invendu'],
    ideas: {
      en: ['Happy-hour boxes at 2 pm', 'Partner with a surplus-food app', 'Donate unsold meals to a local charity'],
      fr: ['Box happy hour à 14 h', 'Partenariat avec une appli anti-gaspi', 'Dons des invendus à une association'],
    },
  },
  {
    keywords: ['compost', 'herb', 'roof', 'garden', 'herbes', 'toit'],
    ideas: {
      en: ['Bokashi bins on every floor', 'Coffee grounds to the rooftop garden', 'Monthly harvest lunch with the herbs'],
      fr: ['Bacs bokashi à chaque étage', 'Marc de café pour le potager du toit', 'Déjeuner récolte une fois par mois'],
    },
  },
  {
    keywords: ['scale', 'measure', 'weigh', 'track', 'balance', 'mesur'],
    ideas: {
      en: ['Weekly waste report per dish', 'Camera that recognises thrown food', 'Dashboard shown at the entrance'],
      fr: ['Rapport hebdo du gaspillage par plat', 'Caméra qui reconnaît les aliments jetés', 'Tableau de bord affiché à l’entrée'],
    },
  },
];

export function expandIdea(title: string, lang: Lang = 'en'): string[] {
  const n = ` ${normalize(title)} `;
  const e = EXPANSIONS.find((x) => x.keywords.some((k) => n.includes(` ${k}`)));
  if (e) return e.ideas[lang];
  return lang === 'fr'
    ? ['Tester avec une seule équipe pendant deux semaines', 'Mesurer l’impact avant et après', 'Trouver la première version la moins chère']
    : ['Pilot it with one team for two weeks', 'Measure the impact before and after', 'Find the cheapest first version'];
}

const ANGLES: { keywords: string[]; angles: L<{ angle: string; objective: string }[]> }[] = [
  {
    keywords: ['pre order', 'preorder', 'ordering', 'booking', 'pre command', 'commande'],
    angles: {
      en: [
        { angle: 'Existing tools', objective: 'Which products already let employees pre-order canteen meals' },
        { angle: 'Adoption', objective: 'What makes employees actually use a pre-ordering system' },
        { angle: 'Forecasting', objective: 'How kitchens forecast demand to cook closer to reality' },
      ],
      fr: [
        { angle: 'Outils existants', objective: 'Quels produits permettent déjà de pré-commander en cantine' },
        { angle: 'Adoption', objective: 'Ce qui pousse vraiment les salariés à utiliser la pré-commande' },
        { angle: 'Prévision', objective: 'Comment les cuisines prévoient la demande' },
      ],
    },
  },
  {
    keywords: ['compost', 'circular', 'organic', 'compostage'],
    angles: {
      en: [
        { angle: 'On-site options', objective: 'Composting methods that work inside an office building' },
        { angle: 'Partners', objective: 'Who collects and processes food waste from offices' },
        { angle: 'Rules', objective: 'Regulations on separating and recycling food waste' },
      ],
      fr: [
        { angle: 'Sur place', objective: 'Méthodes de compostage possibles dans un immeuble de bureaux' },
        { angle: 'Partenaires', objective: 'Qui collecte et traite les biodéchets des bureaux' },
        { angle: 'Règles', objective: 'La réglementation sur le tri des biodéchets' },
      ],
    },
  },
];

export function anglesFor(theme: string, lang: Lang = 'en'): { angle: string; objective: string }[] {
  const n = ` ${normalize(theme)} `;
  const found = ANGLES.find((a) => a.keywords.some((k) => n.includes(` ${k}`)));
  if (found) return found.angles[lang];
  return lang === 'fr'
    ? [
        { angle: 'Solutions existantes', objective: 'Qui le fait déjà et comment' },
        { angle: 'Besoins', objective: 'Qui a ce problème et ce qu’il veut' },
        { angle: 'Contraintes', objective: 'Ce qui bloque : coût, technique, règles' },
      ]
    : [
        { angle: 'Existing solutions', objective: 'Who already does this and how' },
        { angle: 'User needs', objective: 'Who has this problem and what they want' },
        { angle: 'Constraints', objective: 'What blocks it: cost, tech, rules' },
      ];
}

export const SPARKS: L<string[]> = {
  en: ['What if the chef cooked to order after 1 pm?', 'Could leftovers become tomorrow’s soup of the day?', 'What would a zero-waste lunch day look like?'],
  fr: ['Et si le chef cuisinait à la demande après 13 h ?', 'Les restes pourraient devenir la soupe du lendemain ?', 'À quoi ressemblerait une journée zéro gaspi ?'],
};

export interface CorpusEntry {
  title: L<string>;
  url: string;
  content: L<string>;
  tags: string;
}

// Titles are the insight we want on the card. The UI labels these as offline demo data.
export const CORPUS: CorpusEntry[] = [
  {
    title: { en: 'Food service wastes a big share of food', fr: 'La restauration gaspille une grosse part' },
    url: 'https://www.unep.org/resources/publication/food-waste-index-report-2024',
    content: { en: 'UNEP Food Waste Index 2024: about 1.05 billion tonnes of food wasted in 2022, food service is roughly 28% of it.', fr: 'Indice UNEP 2024 : environ 1,05 milliard de tonnes gaspillées en 2022, dont près de 28 % en restauration.' },
    tags: 'canteen cafeteria waste half thrown statistics meal typical how much cantine moitie poubelle gaspillage',
  },
  {
    title: { en: 'Measure waste per cover before acting', fr: 'Mesurer le gaspillage par couvert d’abord' },
    url: 'https://wrap.org.uk/',
    content: { en: 'WRAP guidance for hospitality: measuring waste per cover is the first step before changing portions or menus.', fr: 'Conseil WRAP : mesurer le gaspillage par couvert avant de changer portions ou menus.' },
    tags: 'measure adoption forecasting hospitality guidance mesurer prevision',
  },
  {
    title: { en: 'AI bin cameras spot overproduction', fr: 'Des caméras sur les poubelles repèrent la surproduction' },
    url: 'https://www.winnowsolutions.com/',
    content: { en: 'Winnow uses cameras and scales on kitchen bins to identify what is thrown away and why.', fr: 'Winnow place caméras et balances sur les poubelles de cuisine pour savoir ce qui est jeté.' },
    tags: 'existing tools scale camera measure kitchen technology outils existants balance',
  },
  {
    title: { en: 'Weigh-and-log platforms for kitchens', fr: 'Des plateformes de pesée pour les cuisines' },
    url: 'https://www.leanpath.com/',
    content: { en: 'Leanpath has staff weigh discarded food; dashboards reveal overproduction patterns to fix.', fr: 'Avec Leanpath, l’équipe pèse les déchets ; les tableaux de bord révèlent la surproduction.' },
    tags: 'existing tools measure dashboard forecasting data outils existants prevision',
  },
  {
    title: { en: 'Surplus meals sold at a discount', fr: 'Les invendus revendus à prix réduit' },
    url: 'https://www.toogoodtogo.com/',
    content: { en: 'Too Good To Go lets food businesses sell unsold surplus as discounted surprise bags at closing time.', fr: 'Too Good To Go permet de vendre les invendus en paniers surprise à prix réduit.' },
    tags: 'existing tools leftovers surplus sell partners app outils existants partenaires',
  },
  {
    title: { en: 'Neighbour-to-neighbour food sharing', fr: 'Le partage de nourriture entre voisins' },
    url: 'https://olioapp.com/',
    content: { en: 'OLIO connects people and businesses to give away surplus food locally instead of binning it.', fr: 'OLIO met en relation particuliers et entreprises pour donner les surplus localement.' },
    tags: 'partners leftovers donate sharing adoption partenaires',
  },
  {
    title: { en: 'Forecasting cooks closer to demand', fr: 'La prévision rapproche la cuisine de la demande' },
    url: 'https://en.wikipedia.org/wiki/Demand_forecasting',
    content: { en: 'Demand forecasting with attendance and history data lets kitchens prepare closer to real demand.', fr: 'Prévoir la demande avec la fréquentation et l’historique permet de cuisiner au plus juste.' },
    tags: 'forecasting attendance calendar pre ordering prediction data prevision commande',
  },
  {
    title: { en: 'Defaults and nudges change choices', fr: 'Les options par défaut changent les choix' },
    url: 'https://en.wikipedia.org/wiki/Nudge_theory',
    content: { en: 'Nudge theory: smart defaults and timely reminders change behaviour without restricting choice.', fr: 'Théorie du nudge : de bons réglages par défaut et des rappels changent les comportements.' },
    tags: 'adoption nudges default reminder behaviour employees salaries',
  },
  {
    title: { en: 'Game mechanics drive engagement', fr: 'Les mécaniques de jeu motivent' },
    url: 'https://en.wikipedia.org/wiki/Gamification',
    content: { en: 'Points, leaderboards and badges increase participation when goals are visible and achievable.', fr: 'Points, classements et badges augmentent la participation si les objectifs sont visibles.' },
    tags: 'adoption gamification leaderboard team points classement equipe',
  },
  {
    title: { en: 'Prevention beats recycling', fr: 'Prévenir vaut mieux que recycler' },
    url: 'https://www.epa.gov/sustainable-management-food',
    content: { en: 'EPA Food Recovery Hierarchy: prevent waste first, then feed people, then compost or digest.', fr: 'Hiérarchie de l’EPA : éviter d’abord, puis nourrir, puis composter ou méthaniser.' },
    tags: 'rules hierarchy compost donate prevention regulation regles reglementation',
  },
  {
    title: { en: 'Composting turns scraps into soil', fr: 'Le compost transforme les restes en terreau' },
    url: 'https://en.wikipedia.org/wiki/Composting',
    content: { en: 'Aerobic composting turns food scraps into soil amendment; needs a balance of greens, browns and air.', fr: 'Le compostage aérobie transforme les restes en amendement ; il faut équilibrer vert, brun et air.' },
    tags: 'on-site options compost garden office roof sur place compostage bureaux',
  },
  {
    title: { en: 'Bokashi works in small indoor spaces', fr: 'Le bokashi marche en intérieur' },
    url: 'https://en.wikipedia.org/wiki/Bokashi_(horticulture)',
    content: { en: 'Bokashi ferments food waste in sealed bins, including cooked food, with little odour.', fr: 'Le bokashi fait fermenter les déchets, même cuits, dans des bacs fermés, sans odeur.' },
    tags: 'on-site options compost bokashi indoor office sur place compostage bureaux',
  },
  {
    title: { en: 'Digesters turn food waste into biogas', fr: 'La méthanisation produit du biogaz' },
    url: 'https://en.wikipedia.org/wiki/Anaerobic_digestion',
    content: { en: 'Anaerobic digestion plants process collected food waste into biogas and digestate.', fr: 'Les méthaniseurs transforment les biodéchets collectés en biogaz et digestat.' },
    tags: 'partners collection biogas compost processing partenaires collecte',
  },
  {
    title: { en: 'EU rules push separate bio-waste collection', fr: 'L’UE impose le tri des biodéchets' },
    url: 'https://food.ec.europa.eu/food-safety/food-waste_en',
    content: { en: 'The EU tracks food waste and sets reduction targets; bio-waste must be collected separately.', fr: 'L’UE suit le gaspillage, fixe des objectifs de réduction et impose la collecte séparée des biodéchets.' },
    tags: 'rules regulation europe separate collection targets regles reglementation recyclage dechets',
  },
];
