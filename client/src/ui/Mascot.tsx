import { motion } from 'motion/react';
import type { NemoMode } from '@nemo/shared';

// Nemo, the mascot: a round, cheerful blob with an idea-bulb antenna.
// Its expression follows what Nemo is doing.

const INK = '#1A1A2E';
const BLUE = '#3B5BFD';
const BLUE_LIGHT = '#6E86FF';
const PINK = '#FF7AB6';
const SUN = '#FFD43B';
const CREAM = '#FFFBF2';

export function Mascot({ mode = 'listening', size = 48 }: { mode?: NemoMode; size?: number }) {
  const thinking = mode === 'thinking' || mode === 'researching';
  const speaking = mode === 'speaking';
  const sleeping = mode === 'idle';
  const look = mode === 'thinking' ? { x: 1.5, y: -3 } : mode === 'researching' ? { x: 3, y: 0 } : { x: 0, y: 0 };

  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 120 124"
      role="img"
      aria-label={`Nemo is ${mode}`}
      animate={{ y: speaking ? [0, -3, 0] : [0, -2, 0] }}
      transition={{ repeat: Infinity, duration: speaking ? 0.5 : 2.6, ease: 'easeInOut' }}
      style={{ overflow: 'visible' }}
    >
      {/* antenna + idea bulb */}
      <path d="M60 26 C 60 18 64 14 68 10" stroke={INK} strokeWidth="4" strokeLinecap="round" fill="none" />
      <motion.circle
        cx="70"
        cy="8"
        r="7"
        stroke={INK}
        strokeWidth="3.5"
        animate={{ fill: thinking ? [SUN, CREAM, SUN] : SUN, scale: thinking ? [1, 1.25, 1] : 1 }}
        transition={{ repeat: thinking ? Infinity : 0, duration: 0.9 }}
        style={{ transformOrigin: '70px 8px' }}
      />
      {thinking && (
        <g stroke={SUN} strokeWidth="3" strokeLinecap="round">
          <path d="M82 2 l5 -3" />
          <path d="M84 10 h6" />
          <path d="M58 0 l-4 -4" />
        </g>
      )}

      {/* feet */}
      <ellipse cx="44" cy="114" rx="11" ry="6" fill={BLUE} stroke={INK} strokeWidth="4" />
      <ellipse cx="76" cy="114" rx="11" ry="6" fill={BLUE} stroke={INK} strokeWidth="4" />

      {/* body */}
      <path
        d="M60 24 C 92 24 108 46 108 72 C 108 98 88 112 60 112 C 32 112 12 98 12 72 C 12 46 28 24 60 24 Z"
        fill={BLUE}
        stroke={INK}
        strokeWidth="4.5"
      />
      {/* shine */}
      <path d="M30 50 C 34 40 42 34 50 32" stroke={BLUE_LIGHT} strokeWidth="6" strokeLinecap="round" fill="none" />

      {/* little arms */}
      <path d="M14 78 C 6 80 4 88 9 92" stroke={INK} strokeWidth="4" strokeLinecap="round" fill="none" />
      <motion.path
        d="M106 78 C 114 76 117 68 113 62"
        stroke={INK}
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
        animate={{ rotate: speaking ? [0, -14, 0] : 0 }}
        transition={{ repeat: speaking ? Infinity : 0, duration: 0.7 }}
        style={{ transformOrigin: '106px 78px' }}
      />

      {/* eyes */}
      {sleeping ? (
        <g stroke={INK} strokeWidth="4" strokeLinecap="round" fill="none">
          <path d="M36 64 Q 44 70 52 64" />
          <path d="M68 64 Q 76 70 84 64" />
        </g>
      ) : (
        <motion.g animate={{ scaleY: [1, 1, 0.1, 1] }} transition={{ repeat: Infinity, duration: 4, times: [0, 0.92, 0.96, 1] }} style={{ transformOrigin: '60px 62px' }}>
          <ellipse cx="44" cy="62" rx="10" ry="12" fill={CREAM} stroke={INK} strokeWidth="3.5" />
          <ellipse cx="76" cy="62" rx="10" ry="12" fill={CREAM} stroke={INK} strokeWidth="3.5" />
          <motion.g animate={look} transition={{ type: 'spring', stiffness: 200, damping: 14 }}>
            <circle cx="46" cy="64" r="5.5" fill={INK} />
            <circle cx="78" cy="64" r="5.5" fill={INK} />
            <circle cx="48" cy="61.5" r="2" fill={CREAM} />
            <circle cx="80" cy="61.5" r="2" fill={CREAM} />
          </motion.g>
        </motion.g>
      )}

      {/* cheeks */}
      <ellipse cx="31" cy="80" rx="7.5" ry="4.5" fill={PINK} opacity="0.9" />
      <ellipse cx="89" cy="80" rx="7.5" ry="4.5" fill={PINK} opacity="0.9" />

      {/* mouth */}
      {speaking ? (
        <motion.g animate={{ scaleY: [1, 0.45, 1] }} transition={{ repeat: Infinity, duration: 0.32 }} style={{ transformOrigin: '60px 84px' }}>
          <path d="M48 81 Q 60 81 72 81 Q 70 97 60 97 Q 50 97 48 81 Z" fill={INK} />
          <ellipse cx="60" cy="92" rx="6" ry="3.5" fill={PINK} />
        </motion.g>
      ) : thinking ? (
        <path d="M52 86 Q 60 82 68 86" stroke={INK} strokeWidth="4" strokeLinecap="round" fill="none" />
      ) : (
        <path d="M46 81 Q 60 96 74 81" stroke={INK} strokeWidth="4.5" strokeLinecap="round" fill="none" />
      )}
    </motion.svg>
  );
}
