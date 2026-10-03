import { describe, expect, it } from 'vitest';
import type { S2C } from '@nemo/shared';
import { Room } from '../src/application/room.ts';
import type { RoomPublisher } from '../src/application/ports/index.ts';
import { OfflineLanguageModel } from '../src/adapters/fakes/offline-llm.ts';
import { OfflineWebSearch } from '../src/adapters/fakes/offline-search.ts';
import { recoverInlineToolCalls } from '../src/adapters/outbound/chat-completions.ts';

class Collector implements RoomPublisher {
  all: S2C[] = [];
  host: (S2C | Buffer)[] = [];
  broadcast(_c: string, m: S2C) {
    this.all.push(m);
  }
  toHost(_c: string, m: S2C | Buffer) {
    this.host.push(m);
  }
  said() {
    return this.host.filter((m): m is Extract<S2C, { t: 'say' }> => !Buffer.isBuffer(m) && m.t === 'say').map((m) => m.text);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRoom() {
  const pub = new Collector();
  const room = new Room('TEST', {
    llm: new OfflineLanguageModel(),
    search: new OfflineWebSearch(),
    tts: null,
    publisher: pub,
    clock: { now: () => Date.now() },
    log: { info() {}, warn() {}, error() {} },
    capabilities: { asr: 'browser', tts: 'browser', llm: 'offline', search: 'offline', demo: true },
  });
  return { room, pub };
}

async function settle(room: Room, pub: Collector) {
  // Simulate the host finishing playback of anything Nemo says.
  for (let i = 0; i < 30; i++) {
    await sleep(60);
    room.handlePlayback(false);
  }
  void pub;
}

describe('Room (offline adapters)', () => {
  it('turns spoken ideas into numbered cards and applies voice commands', async () => {
    const { room, pub } = makeRoom();
    room.handleFinal("Nemo, today we're brainstorming how might we cut food waste in the cafeteria.");
    await settle(room, pub);
    room.handleFinal('What if people pre-order their lunch the day before?');
    await settle(room, pub);
    room.handleFinal('We could sell leftovers cheap at the end of the day.');
    await settle(room, pub);
    expect(room.canvas.getTopic().toLowerCase()).toContain('food waste');
    expect(room.canvas.cardCount(['idea'])).toBe(2);

    room.handleFinal('Nemo, merge 1 and 2.');
    await settle(room, pub);
    expect(room.canvas.cardCount(['idea'])).toBe(1);
    // No announcement: the board shows the merge.
    expect(pub.said()).toHaveLength(0);
  });

  it('runs research in parallel and writes a sourced fact card', async () => {
    const { room, pub } = makeRoom();
    room.handleFinal('Nemo, look up how much food canteens waste.');
    await settle(room, pub);
    await sleep(800);
    const facts = room.canvas.cardsList().filter((c) => c.kind === 'fact');
    expect(facts.length).toBe(1);
    expect(facts[0].sources.length).toBeGreaterThan(0);
  });

  it('spawns parallel sub-agents that write into their own lanes', async () => {
    const { room, pub } = makeRoom();
    room.handleFinal('Nemo, explore pre-ordering systems in workplace canteens.');
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      room.handlePlayback(false);
      if (room.view().agents.length && room.view().agents.every((a) => a.state === 'done')) break;
    }
    const agents = room.view().agents;
    expect(agents.length).toBe(3);
    expect(agents.every((a) => a.state === 'done')).toBe(true);
    const lanes = new Set(room.canvas.cardsList().filter((c) => c.kind === 'fact').map((c) => c.clusterId));
    expect(lanes.size).toBeGreaterThanOrEqual(2);
    expect(room.canvas.cardsList().some((c) => c.kind === 'exploring')).toBe(false);
  });
});

describe('Voice zoom', () => {
  it('focuses instantly on a theme by name, number, subject, card, or the overview', () => {
    const { room } = makeRoom();
    room.canvas.addCard({ title: 'Pre-order lunch in an app', cluster: 'Pre-ordering' });
    room.canvas.addCard({ title: 'Compost peelings for the roof garden', cluster: 'Circularity' });
    room.canvas.addCard({ title: 'Sell leftovers cheap', cluster: 'Leftovers' });
    const focusAfter = (said: string) => {
      room.handleFinal(said);
      return room.view().focus;
    };
    const ids = Object.fromEntries(room.canvas.clusterList().map((c) => [c.label, c.id]));
    expect(focusAfter('Nemo, zoom on pre-ordering')).toMatchObject({ kind: 'cluster', ref: ids['Pre-ordering'] });
    expect(focusAfter('show me theme 3')).toMatchObject({ kind: 'cluster', ref: ids['Leftovers'] });
    expect(focusAfter('montre-moi celui sur le compost')).toMatchObject({ kind: 'cluster', ref: ids['Circularity'] });
    expect(focusAfter('zoome sur la 1')).toMatchObject({ kind: 'card' });
    expect(focusAfter("vue d'ensemble")).toMatchObject({ kind: 'all' });
    expect(focusAfter('zoome sur chacun des thèmes')).toMatchObject({ kind: 'tour' });
  });
});

describe('Nemo only speaks when asked out loud', () => {
  it('stays silent on a plain lookup, speaks when told to', async () => {
    const { room, pub } = makeRoom();
    room.handleFinal('Nemo, look up how much food canteens waste.');
    await settle(room, pub);
    await sleep(800);
    expect(room.canvas.cardsList().some((c) => c.kind === 'fact')).toBe(true);
    expect(pub.said()).toHaveLength(0);
  });
});

describe('Nemo never talks over people', () => {
  it('waits for the room to pause, and stops when someone talks over it', async () => {
    const { room, pub } = makeRoom();
    room.handleVoice(true); // someone starts talking
    room.handleFinal('Nemo, look up how much food canteens waste and tell us.');
    await sleep(1500);
    expect(pub.said()).toHaveLength(0); // still talking: Nemo waits
    room.handleVoice(false);
    for (let i = 0; i < 20 && pub.said().length === 0; i++) await sleep(100);
    expect(pub.said().length).toBeGreaterThan(0);
    // Someone talks over Nemo: it stops (audio end sent) and becomes interruptible again.
    room.interrupt();
    expect(room.view().mode).not.toBe('speaking');
  });
});

describe('Nemotron adapter', () => {
  it('recovers inline qwen3-coder style tool calls', () => {
    const calls = recoverInlineToolCalls('<tool_call>\n<function=act>\n<parameter=intent>\nidea_content\n</parameter>\n<parameter=add_ideas>\n["A", "B"]\n</parameter>\n</function>\n</tool_call>');
    expect(calls[0].name).toBe('act');
    expect(calls[0].args.add_ideas).toEqual(['A', 'B']);
  });
});
