// Interruption budget (token bucket). Nemo spends tokens to interrupt the room
// unprompted; answering a direct request is free.

export type InterventionCost = 'canvas' | 'popup' | 'voice' | 'method';
const COST: Record<InterventionCost, number> = { canvas: 0, popup: 1, voice: 2, method: 3 };

export type Proactivity = 'quiet' | 'balanced' | 'active';
const REFILL_MS: Record<Proactivity, number> = { quiet: 120_000, balanced: 60_000, active: 30_000 };

export class InterruptionBudget {
  private tokens: number;
  private lastRefill: number;
  private lastVoiceAt = -Infinity;

  constructor(
    private now: () => number = Date.now,
    readonly max = 3,
    public proactivity: Proactivity = 'balanced',
    private minVoiceGapMs = 60_000,
  ) {
    this.tokens = max;
    this.lastRefill = now();
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  canSpend(kind: InterventionCost): boolean {
    this.refill();
    if (kind === 'voice' || kind === 'method') {
      if (this.now() - this.lastVoiceAt < this.minVoiceGapMs) return false;
    }
    return this.tokens >= COST[kind];
  }

  /** Returns true if spent. */
  spend(kind: InterventionCost): boolean {
    if (!this.canSpend(kind)) return false;
    this.tokens -= COST[kind];
    if (kind === 'voice' || kind === 'method') this.lastVoiceAt = this.now();
    return true;
  }

  private refill() {
    const t = this.now();
    const gained = (t - this.lastRefill) / REFILL_MS[this.proactivity];
    if (gained > 0) {
      this.tokens = Math.min(this.max, this.tokens + gained);
      this.lastRefill = t;
    }
  }
}
