import { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRightIcon, MagnifyingGlassIcon, MicrophoneIcon, SparkleIcon, UsersThreeIcon } from '@phosphor-icons/react';
import type { Lang } from '@nemo/shared';
import { NemoFace } from '../ui/panels';
import { storedLang, storeLang, tr } from '../i18n';

const DEMO_TOPICS: Record<Lang, string> = {
  en: 'How might we cut food waste in our office cafeteria?',
  fr: 'Comment réduire le gaspillage alimentaire à la cantine du bureau ?',
};

export function Landing({ go, joinOnly }: { go: (path: string) => void; joinOnly?: boolean }) {
  const [lang, setLang] = useState<Lang>(storedLang());
  const [topic, setTopic] = useState('');
  const [code, setCode] = useState('');
  const t = (k: Parameters<typeof tr>[1]) => tr(lang, k);
  const choose = (l: Lang) => {
    setLang(l);
    storeLang(l);
  };
  const start = (topicText: string) => {
    sessionStorage.setItem('nemo.topic', topicText);
    sessionStorage.removeItem('nemo.host.code');
    storeLang(lang);
    go('/host');
  };
  return (
    <div className="min-h-dvh bg-cream dotgrid flex flex-col items-center justify-center p-6">
      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="max-w-3xl w-full">
        <div className="flex items-center gap-4">
          <NemoFace mode="listening" size={84} />
          <div className="min-w-0">
            <h1 className="font-display font-extrabold text-5xl leading-none">Nemo</h1>
            <p className="font-display font-bold text-lg opacity-70 mt-1">{t('tagline')}</p>
          </div>
          <div className="ml-auto panel !shadow-brut-sm flex p-1 gap-1 shrink-0" role="radiogroup" aria-label="Language">
            {(['en', 'fr'] as Lang[]).map((l) => (
              <button
                key={l}
                role="radio"
                aria-checked={lang === l}
                onClick={() => choose(l)}
                className={`px-3 py-1 rounded-xl font-display font-extrabold text-sm cursor-pointer ${lang === l ? 'bg-brand text-white' : 'opacity-60 hover:opacity-100'}`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-[1.4fr_1fr]">
          {!joinOnly && (
            <div className="panel !shadow-brut-lg p-6 bg-white">
              <div className="flex items-center gap-2 font-display font-extrabold text-xl">
                <MicrophoneIcon size={22} weight="bold" />
                {t('runTitle')}
              </div>
              <label className="block mt-4 text-sm font-bold opacity-70">{t('topicLabel')}</label>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t('topicPlaceholder')}
                className="mt-1 w-full border-2 border-ink rounded-card px-3 py-2.5 bg-cream outline-none focus:bg-sun-soft"
              />
              <div className="mt-4 flex gap-3 flex-wrap">
                <button className="btn bg-sun" onClick={() => start(topic)}>
                  {t('start')}
                  <ArrowRightIcon size={18} weight="bold" />
                </button>
                <button className="btn bg-brand-soft" onClick={() => start(DEMO_TOPICS[lang])}>
                  {t('demoTopic')}
                </button>
              </div>
            </div>
          )}

          <div className="panel !shadow-brut-lg p-6 bg-pink-soft">
            <div className="flex items-center gap-2 font-display font-extrabold text-xl">
              <UsersThreeIcon size={22} weight="bold" />
              {t('watchTitle')}
            </div>
            <p className="text-sm mt-2 opacity-70">{t('watchHint')}</p>
            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim().length === 4) go(`/room/${code.trim().toUpperCase()}`);
              }}
            >
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
                placeholder="ABCD"
                className="w-32 border-2 border-ink rounded-card px-3 py-2.5 bg-white font-display font-extrabold tracking-[0.3em] text-xl outline-none uppercase"
              />
              <button className="btn bg-white" type="submit">
                {t('join')}
              </button>
            </form>
          </div>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            { Icon: MicrophoneIcon, title: t('f1t'), d: t('f1d'), bg: 'bg-sun-soft' },
            { Icon: MagnifyingGlassIcon, title: t('f2t'), d: t('f2d'), bg: 'bg-brand-soft' },
            { Icon: SparkleIcon, title: t('f3t'), d: t('f3d'), bg: 'bg-mint-soft' },
          ].map(({ Icon, title, d, bg }) => (
            <div key={title} className={`panel !shadow-brut-sm p-4 ${bg}`}>
              <Icon size={22} weight="duotone" />
              <div className="font-display font-extrabold mt-2">{title}</div>
              <div className="text-sm opacity-75 mt-1">{d}</div>
            </div>
          ))}
        </div>
        <p className="mt-6 text-xs font-bold opacity-50">{t('poweredBy')}</p>
      </motion.div>
    </div>
  );
}
