import type { CardKind, Lang } from '@nemo/shared';

// Interface strings. The session language is picked on the landing page and
// travels with the room, so viewers see the host's language.

const UI = {
  tagline: { en: 'Brainstorm out loud. Nemo listens, researches and builds the board.', fr: 'Réfléchissez à voix haute. Nemo écoute, cherche et construit le tableau.' },
  runTitle: { en: 'Run a session on this computer', fr: 'Lancer une session sur cet ordinateur' },
  topicLabel: { en: 'What are you brainstorming? (optional, you can also just say it)', fr: 'Sur quoi réfléchissez-vous ? (facultatif, vous pouvez aussi le dire)' },
  topicPlaceholder: { en: 'How might we…', fr: 'Comment pourrions-nous…' },
  start: { en: 'Start session', fr: 'Démarrer' },
  demoTopic: { en: 'Try the demo topic', fr: 'Essayer le sujet de démo' },
  watchTitle: { en: 'Watch a session', fr: 'Suivre une session' },
  watchHint: { en: 'Enter the 4-letter code shown on the room screen.', fr: 'Entrez le code à 4 lettres affiché dans la salle.' },
  join: { en: 'Join', fr: 'Rejoindre' },
  f1t: { en: 'Listens to the room', fr: 'Écoute la salle' },
  f1d: { en: 'One mic, NVIDIA speech-to-text. Every idea lands on the board.', fr: 'Un seul micro, transcription NVIDIA. Chaque idée arrive sur le tableau.' },
  f2t: { en: 'Researches in parallel', fr: 'Cherche en parallèle' },
  f2d: { en: 'Web search and sub-agents, without blocking the talk.', fr: 'Recherche web et sous-agents, sans bloquer la discussion.' },
  f3t: { en: 'Knows when to speak', fr: 'Sait quand parler' },
  f3d: { en: 'Facilitates, challenges and unblocks, with an interruption budget.', fr: 'Anime, challenge et débloque, avec un budget d’interruptions.' },
  poweredBy: {
    en: 'Powered by NVIDIA Nemotron on Nebius Token Factory, NVIDIA speech NIMs on Nebius AI Cloud, and Tavily.',
    fr: 'Propulsé par NVIDIA Nemotron sur Nebius Token Factory, les NIM vocaux NVIDIA sur Nebius AI Cloud, et Tavily.',
  },
  wakeTitle: { en: 'Wake Nemo up', fr: 'Réveillez Nemo' },
  wakeBody: {
    en: 'Put this computer where everyone can be heard. Nemo will listen to the room, build the board and speak through the speakers.',
    fr: 'Placez cet ordinateur là où tout le monde est entendu. Nemo écoute la salle, construit le tableau et parle dans les haut-parleurs.',
  },
  topic: { en: 'Topic', fr: 'Sujet' },
  startListening: { en: 'Start listening', fr: 'Commencer l’écoute' },
  connecting: { en: 'Connecting…', fr: 'Connexion…' },
  joining: { en: 'Joining', fr: 'Connexion à' },
  tryAnother: { en: 'Try another code', fr: 'Essayer un autre code' },
  demo: { en: 'Demo', fr: 'Démo' },
  demoTitle: { en: 'Play a scripted conversation through the real pipeline', fr: 'Jouer une conversation scriptée dans la vraie chaîne' },
  emptyTitle: { en: 'Just talk. Nemo builds the board.', fr: 'Parlez. Nemo construit le tableau.' },
  liveTranscript: { en: 'Live transcript', fr: 'Transcription en direct' },
  transcriptEmpty: { en: 'Say “Hey Nemo” to start, or press Demo.', fr: 'Dites « Hé Nemo » pour commencer, ou lancez la démo.' },
  room: { en: 'Room', fr: 'Salle' },
  freshIdeas: { en: 'Fresh ideas', fr: 'Nouvelles idées' },
  summaryLabel: { en: 'Session summary', fr: 'Synthèse de la session' },
  pick: { en: 'pick · card', fr: 'choix · carte' },
  themes: { en: 'Themes', fr: 'Thèmes' },
  risks: { en: 'Risks', fr: 'Risques' },
  openQuestions: { en: 'Open questions', fr: 'Questions ouvertes' },
  nextSteps: { en: 'Next steps', fr: 'Prochaines étapes' },
  sources: { en: 'Sources', fr: 'Sources' },
  download: { en: 'Download Markdown', fr: 'Télécharger en Markdown' },
  copy: { en: 'Copy', fr: 'Copier' },
  noAsr: {
    en: 'This browser has no speech recognition. Use Chrome, or configure a speech-to-text provider.',
    fr: 'Ce navigateur n’a pas de reconnaissance vocale. Utilisez Chrome, ou configurez un fournisseur de transcription.',
  },
} satisfies Record<string, Record<Lang, string>>;

export type UiKey = keyof typeof UI;

export function tr(lang: Lang, key: UiKey): string {
  return UI[key][lang] ?? UI[key].en;
}

export const KIND_LABELS: Record<Lang, Record<CardKind, string>> = {
  en: { idea: 'Idea', ai_idea: 'Nemo spark', fact: 'Sourced', risk: 'Concern', question: 'Question', decision: 'Shortlisted', feature: 'Feature', exploring: 'Agent at work' },
  fr: { idea: 'Idée', ai_idea: 'Étincelle', fact: 'Sourcé', risk: 'Réserve', question: 'Question', decision: 'Retenue', feature: 'Fonctionnalité', exploring: 'Agent en cours' },
};

export function storedLang(): Lang {
  try {
    return localStorage.getItem('nemo.lang') === 'fr' ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

export function storeLang(lang: Lang) {
  try {
    localStorage.setItem('nemo.lang', lang);
  } catch {
    /* private mode */
  }
}
