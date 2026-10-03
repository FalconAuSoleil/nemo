import { describe, expect, it } from 'vitest';
import { Canvas, CanvasError } from '../src/domain/canvas.ts';
import { InterruptionBudget } from '../src/domain/budget.ts';
import { Session, resolveMethod } from '../src/domain/session.ts';
import { detectWakeWord } from '../src/domain/wakeword.ts';

describe('Canvas', () => {
  it('numbers cards in arrival order and dedupes near-identical titles', () => {
    const c = new Canvas(() => 0);
    const a = c.addCard({ title: 'Pre-order lunch in an app' });
    const b = c.addCard({ title: 'Sell leftovers cheap' });
    const dup = c.addCard({ title: 'Pre-order lunch in the app' });
    expect([a.card.num, b.card.num]).toEqual([1, 2]);
    expect(dup.duplicateOf?.num).toBe(1);
    expect(c.cardCount()).toBe(2);
  });

  it('merges cards, keeps links and drops self-links', () => {
    const c = new Canvas(() => 0);
    c.addCard({ title: 'Smaller portions' });
    c.addCard({ title: 'Free seconds' });
    c.addCard({ title: 'Compost leftovers' });
    c.link(2, 3);
    c.link(1, 2);
    c.merge([1, 2], 'Smaller portions, free seconds');
    expect(c.byNum(2)).toBeUndefined();
    expect(c.byNum(1)?.title).toBe('Smaller portions, free seconds');
    expect(c.state().links).toHaveLength(1);
  });

  it('moves cards into clusters created on demand and rejects unknown numbers', () => {
    const c = new Canvas(() => 0);
    c.addCard({ title: 'QR code at the entrance' });
    c.move([1], 'Pre-ordering');
    const cl = c.findCluster('pre-ordering');
    expect(cl).toBeDefined();
    expect(c.byNum(1)?.clusterId).toBe(cl!.id);
    expect(() => c.remove(42)).toThrow(CanvasError);
  });
});

describe('Wake word', () => {
  it('accepts common ASR variants and strips them', () => {
    expect(detectWakeWord('Hey Nemo, merge 3 and 7').addressed).toBe(true);
    expect(detectWakeWord('nimo look that up').command).toBe('look that up');
    expect(detectWakeWord('Neemo, stop').addressed).toBe(true);
  });
  it('ignores "demo" in the middle of a sentence', () => {
    expect(detectWakeWord('we need a better demo for the client').addressed).toBe(false);
  });
});

describe('Interruption budget', () => {
  it('limits unsolicited interventions and refills over time', () => {
    let t = 0;
    const b = new InterruptionBudget(() => t, 3, 'balanced', 60_000);
    expect(b.spend('voice')).toBe(true); // 3 -> 1
    expect(b.spend('voice')).toBe(false); // min gap
    expect(b.spend('popup')).toBe(true); // 1 -> 0
    expect(b.spend('popup')).toBe(false);
    t += 120_000;
    expect(b.available()).toBe(2);
    expect(b.spend('voice')).toBe(true);
  });
});

describe('Session', () => {
  it('resolves spoken method names', () => {
    expect(resolveMethod('six hats')).toBe('six_hats');
    expect(resolveMethod('SCAMPER')).toBe('scamper');
    expect(resolveMethod('pre-mortem')).toBe('premortem');
    expect(resolveMethod('worst idea')).toBe('worst_idea');
  });

  it('runs a method step by step', () => {
    let t = 0;
    const s = new Session(() => t);
    const run = s.startMethod('scamper', 4)!;
    expect(run.steps[0]).toContain('#4');
    t += 61_000;
    expect(s.tickMethod()?.line).toMatch(/Substitute/);
  });

  it('detects a stall when the room goes silent while diverging', () => {
    let t = 0;
    const s = new Session(() => t);
    s.setPhase('DIVERGE');
    t += 35_000;
    expect(s.detectStall(5)?.method).toBe('worst_idea');
  });
});
