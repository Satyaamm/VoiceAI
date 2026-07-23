/**
 * Circuit Breaker + fallback executor.
 *
 * docs/03-problem-coverage.md 6.3: a vendor outage must degrade, never take the
 * platform down. Every provider call goes through a breaker; when one trips, the
 * FallbackExecutor walks to the next provider in the ladder.
 *
 * Critically, the breaker also enforces a per-call TIMEOUT. On a phone call a slow
 * dependency is worse than a failed one — a hung CRM API must never hang a call.
 */

import { Err, Ok, type Result } from './result.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures before opening. */
  failureThreshold: number;
  /** How long to stay open before probing again. */
  resetTimeoutMs: number;
  /** Hard ceiling on a single call. */
  timeoutMs: number;
  /** Successes required in half-open before closing. */
  successThreshold: number;
}

const DEFAULTS: BreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 10_000,
  timeoutMs: 2_000,
  successThreshold: 2,
};

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`circuit open: ${name}`);
    this.name = 'CircuitOpenError';
  }
}

export class TimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`${name} exceeded ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;

  private readonly opts: BreakerOptions;

  constructor(
    readonly name: string,
    opts: Partial<BreakerOptions> = {},
    private readonly onStateChange?: (name: string, state: BreakerState) => void,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  getState(): BreakerState {
    // Lazily transition open -> half-open once the cooldown elapses.
    if (this.state === 'open' && Date.now() - this.openedAt >= this.opts.resetTimeoutMs) {
      this.transition('half-open');
    }
    return this.state;
  }

  async execute<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<Result<T, Error>> {
    if (this.getState() === 'open') {
      return Err(new CircuitOpenError(this.name));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    try {
      const value = await Promise.race([
        fn(controller.signal),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () =>
            reject(new TimeoutError(this.name, this.opts.timeoutMs)),
          ),
        ),
      ]);
      this.recordSuccess();
      return Ok(value);
    } catch (e) {
      this.recordFailure();
      return Err(e instanceof Error ? e : new Error(String(e)));
    } finally {
      clearTimeout(timer);
    }
  }

  private recordSuccess(): void {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.successes += 1;
      if (this.successes >= this.opts.successThreshold) this.transition('closed');
    }
  }

  private recordFailure(): void {
    this.successes = 0;
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.opts.failureThreshold) {
      this.openedAt = Date.now();
      this.transition('open');
    }
  }

  private transition(next: BreakerState): void {
    if (this.state === next) return;
    this.state = next;
    if (next === 'half-open') this.successes = 0;
    if (next === 'closed') this.failures = 0;
    this.onStateChange?.(this.name, next);
  }
}

/**
 * Walks a provider ladder until one succeeds.
 *
 * `docs/01-architecture.md` §7: primary in-house -> secondary in-house -> vendor API.
 * Each rung gets its own breaker, so a dead primary is skipped instantly rather
 * than costing a timeout on every single call.
 */
export class FallbackExecutor<TProvider> {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly name: string,
    private readonly keyOf: (p: TProvider) => string,
    private readonly breakerOpts: Partial<BreakerOptions> = {},
    private readonly onFallback?: (from: string, to: string, error: Error) => void,
  ) {}

  private breakerFor(key: string): CircuitBreaker {
    let b = this.breakers.get(key);
    if (!b) {
      b = new CircuitBreaker(`${this.name}:${key}`, this.breakerOpts);
      this.breakers.set(key, b);
    }
    return b;
  }

  async run<T>(
    ladder: TProvider[],
    fn: (provider: TProvider, signal: AbortSignal) => Promise<T>,
  ): Promise<Result<{ value: T; providerKey: string; attempts: number }, Error>> {
    let lastError: Error = new Error(`${this.name}: empty provider ladder`);
    let attempts = 0;

    for (const provider of ladder) {
      const key = this.keyOf(provider);
      attempts += 1;
      const result = await this.breakerFor(key).execute((signal) => fn(provider, signal));

      if (result.ok) {
        return Ok({ value: result.value, providerKey: key, attempts });
      }
      lastError = result.error;
      const next = ladder[attempts];
      if (next) this.onFallback?.(key, this.keyOf(next), result.error);
    }

    return Err(lastError);
  }

  /** Exposed for the dashboard's provider-health panel. */
  states(): Record<string, BreakerState> {
    return Object.fromEntries([...this.breakers].map(([k, b]) => [k, b.getState()]));
  }
}
