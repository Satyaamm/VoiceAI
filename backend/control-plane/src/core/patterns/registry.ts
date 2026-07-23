/**
 * Registry pattern.
 *
 * Everything pluggable in this platform is registered by key rather than imported
 * directly: STT/LLM/TTS providers, endpointing strategies, guardrails, tools,
 * telephony carriers. That gives us three things we need:
 *
 *   1. Swap a component per-agent from config, with no code change.
 *   2. Register a fallback chain (see FallbackRegistry) so a vendor outage
 *      degrades instead of failing — problem 6.3 in PROBLEM-COVERAGE.md.
 *   3. Enumerate what's available for the dashboard's dropdowns.
 */

import { Err, Ok, type Result } from './result.js';

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface RegistryEntry<T> {
  readonly key: string;
  readonly value: T;
  /** Human label for dashboard dropdowns. */
  readonly label: string;
  /** Higher wins when resolving a fallback chain. */
  readonly priority: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RegisterOptions {
  label?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
  /** Allow replacing an existing key. Off by default so collisions are loud. */
  override?: boolean;
}

export class Registry<T> {
  protected readonly entries = new Map<string, RegistryEntry<T>>();

  constructor(readonly name: string) {}

  register(key: string, value: T, opts: RegisterOptions = {}): this {
    if (this.entries.has(key) && !opts.override) {
      throw new RegistryError(
        `[${this.name}] duplicate registration for "${key}" — pass { override: true } if intentional`,
        key,
      );
    }
    this.entries.set(key, {
      key,
      value,
      label: opts.label ?? key,
      priority: opts.priority ?? 0,
      metadata: Object.freeze({ ...opts.metadata }),
    });
    return this;
  }

  /** Throwing lookup — for startup wiring, where a missing key is a bug. */
  get(key: string): T {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new RegistryError(
        `[${this.name}] unknown key "${key}". Registered: ${this.keys().join(', ') || '(none)'}`,
        key,
      );
    }
    return entry.value;
  }

  /** Non-throwing lookup — for the hot path, where we degrade instead of crash. */
  resolve(key: string): Result<T, RegistryError> {
    const entry = this.entries.get(key);
    return entry
      ? Ok(entry.value)
      : Err(new RegistryError(`[${this.name}] unknown key "${key}"`, key));
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Sorted high-priority-first. Used to build fallback ladders. */
  all(): RegistryEntry<T>[] {
    return [...this.entries.values()].sort((a, b) => b.priority - a.priority);
  }

  /** Shape the dashboard consumes for select inputs. */
  options(): Array<{ value: string; label: string; metadata: Record<string, unknown> }> {
    return this.all().map((e) => ({
      value: e.key,
      label: e.label,
      metadata: { ...e.metadata },
    }));
  }
}

/**
 * A registry that resolves through an ordered fallback ladder.
 *
 * ARCHITECTURE.md §7: primary in-house model -> secondary in-house -> vendor API.
 * `resolveChain` returns every candidate in priority order; the caller (usually a
 * circuit-breaker-wrapped executor) walks the list until one succeeds.
 */
export class FallbackRegistry<T> extends Registry<T> {
  private chain: string[] = [];

  /** Explicit ordering beats priority when set — config should win over defaults. */
  setChain(keys: string[]): this {
    for (const k of keys) {
      if (!this.has(k)) {
        throw new RegistryError(`[${this.name}] cannot chain unknown key "${k}"`, k);
      }
    }
    this.chain = [...keys];
    return this;
  }

  resolveChain(preferred?: string): T[] {
    const ordered = this.chain.length ? this.chain : this.all().map((e) => e.key);
    const keys = preferred
      ? [preferred, ...ordered.filter((k) => k !== preferred)]
      : ordered;
    return keys.filter((k) => this.has(k)).map((k) => this.get(k));
  }
}
