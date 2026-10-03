import type { Lang } from '@nemo/shared';
import type { Room } from '../../application/room.ts';

// A scripted room conversation. It drives the real pipeline (brain, canvas,
// research, sub-agents, voice), with live models when keys are set, or offline.

export const DEMO_TOPIC: Record<Lang, string> = {
  en: 'How might we cut food waste in our office cafeteria?',
  fr: 'Comment réduire le gaspillage alimentaire à la cantine du bureau ?',
};

const DEMO_LINES_EN: { text: string; pauseMs?: number }[] = [
  { text: "Nemo, today we're brainstorming how might we cut food waste in our office cafeteria." },
  { text: 'What if people pre-order their lunch in an app the day before?' },
  { text: 'We could sell leftovers cheap at the end of the day.' },
  { text: 'Maybe smaller default portions with free seconds.' },
  { text: 'I read that like half of all cafeteria food gets thrown away.' },
  { text: 'How about a weekly leaderboard of the teams that waste the least?' },
  { text: 'We should compost whatever is left and grow herbs on the roof.' },
  { text: 'Let’s put a smart scale at the tray return to measure waste.' },
  { text: 'What if the menu adapts to the weather and the meetings calendar?' },
  { text: 'Maybe a QR code at the entrance to book your meal.' },
  { text: 'We could donate unsold meals to a local charity.' },
  { text: 'But honestly, people will never use another app, that won’t work.' },
  { text: 'What if each team gets points for empty plates?' },
  { text: 'We could show a live dashboard of the waste at the entrance.' },
  { text: 'Nemo, merge __PREORDER__ and __QR__.' },
  { text: 'Nemo, explore pre-ordering systems in workplace canteens.', pauseMs: 3000 },
  { text: 'Meanwhile, what if leftovers become takeaway boxes for the evening?' },
  { text: 'We could let the chef cook to order after one pm.' },
  { text: 'Nemo, break down __LEADERBOARD__.', pauseMs: 3000 },
  { text: 'Nemo, look up the rules on recycling food waste in Europe.', pauseMs: 4000 },
  { text: 'Nemo, explore composting options for offices.', pauseMs: 3000 },
  { text: 'Nemo, let’s do SCAMPER on __PREORDER__.', pauseMs: 3000 },
  { text: 'Substitute the app with a paper menu card you tick.' },
  { text: 'Combine pre-ordering with the team points so teams earn more.' },
  { text: 'Nemo, stop.' },
  { text: 'Nemo, move on.', pauseMs: 7000 },
  { text: 'Nemo, vote for __PREORDER__, __LEADERBOARD__ and __SCALE__.' },
  { text: 'Nemo, wrap up.' },
];

const DEMO_LINES_FR: { text: string; pauseMs?: number }[] = [
  { text: "Nemo, aujourd'hui on réfléchit à comment réduire le gaspillage alimentaire à la cantine du bureau." },
  { text: 'Et si les gens pré-commandaient leur déjeuner dans une appli la veille ?' },
  { text: 'On pourrait vendre les restes pas cher en fin de journée.' },
  { text: 'Peut-être des portions plus petites par défaut, avec du rab gratuit.' },
  { text: "J'ai lu que la moitié de la nourriture des cantines finit à la poubelle." },
  { text: 'Pourquoi pas un classement hebdo des équipes qui gaspillent le moins ?' },
  { text: 'On devrait composter les restes et faire pousser des herbes sur le toit.' },
  { text: 'Et si on mettait une balance connectée au retour des plateaux pour mesurer le gaspillage ?' },
  { text: "Et si le menu s'adaptait à la météo et au calendrier des réunions ?" },
  { text: "Peut-être un QR code à l'entrée pour réserver son repas." },
  { text: 'On pourrait donner les repas invendus à une association locale.' },
  { text: "Franchement, les gens n'utiliseront jamais une appli de plus, ça ne marchera pas." },
  { text: 'Et si chaque équipe gagnait des points pour les assiettes vides ?' },
  { text: "On pourrait afficher un tableau de bord du gaspillage en direct à l'entrée." },
  { text: 'Nemo, fusionne __PREORDER__ et __QR__.' },
  { text: "Nemo, explore les systèmes de pré-commande en cantine d'entreprise.", pauseMs: 3000 },
  { text: 'En attendant, et si les restes devenaient des box à emporter pour le soir ?' },
  { text: 'On pourrait laisser le chef cuisiner à la demande après 13 heures.' },
  { text: 'Nemo, décompose la __LEADERBOARD__.', pauseMs: 3000 },
  { text: 'Nemo, cherche les règles sur le recyclage des déchets alimentaires en Europe.', pauseMs: 4000 },
  { text: 'Nemo, explore les solutions de compostage pour les bureaux.', pauseMs: 3000 },
  { text: 'Nemo, on fait un SCAMPER sur la __PREORDER__.', pauseMs: 3000 },
  { text: "On pourrait remplacer l'appli par une carte papier qu'on coche." },
  { text: "On pourrait combiner la pré-commande avec les points d'équipe pour gagner plus." },
  { text: 'Nemo, stop.' },
  { text: 'Nemo, passe à la suite.', pauseMs: 7000 },
  { text: 'Nemo, vote pour __PREORDER__, __LEADERBOARD__ et __SCALE__.' },
  { text: 'Nemo, conclus.' },
];

export const DEMO_LINES: Record<Lang, { text: string; pauseMs?: number }[]> = { en: DEMO_LINES_EN, fr: DEMO_LINES_FR };

export class DemoDirector {
  running = false;

  constructor(
    private room: Room,
    private lang: Lang = 'en',
  ) {}

  async run(lines = DEMO_LINES[this.lang]) {
    if (this.running) return;
    this.running = true;
    try {
      for (const line of lines) {
        await this.waitForQuiet();
        await sleep(1200);
        const text = this.resolve(line.text);
        this.room.handlePartial(text.split(' ').slice(0, 4).join(' '));
        await sleep(600 + text.split(' ').length * 120);
        this.room.handleFinal(text);
        await sleep(line.pauseMs ?? 2200);
      }
    } finally {
      this.running = false;
    }
  }

  /** Card numbers depend on timing, so placeholders are resolved on the live canvas. */
  private resolve(text: string): string {
    const find = (re: RegExp) => this.room.canvas.cardsList().find((c) => (c.kind === 'idea' || c.kind === 'ai_idea') && re.test(c.title.toLowerCase()))?.num;
    const map: Record<string, number | undefined> = {
      __PREORDER__: find(/pre-?order|pr[ée]-?command/),
      __QR__: find(/qr code/),
      __LEADERBOARD__: find(/leaderboard|classement/),
      __SCALE__: find(/scale|balance/),
    };
    return text.replace(/__[A-Z]+__/g, (k) => String(map[k] ?? 1));
  }

  private async waitForQuiet() {
    for (let i = 0; i < 40; i++) {
      const mode = this.room.view().mode;
      if (mode !== 'speaking' && mode !== 'thinking') return;
      await sleep(500);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
