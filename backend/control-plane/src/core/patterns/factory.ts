/**
 * Abstract Factory.
 *
 * Providers are never constructed with `new` at a call site. A factory is
 * registered per provider key and builds a configured instance from plain config,
 * which means:
 *
 *   - agent config (JSON from Postgres) can name a provider and its settings
 *   - credentials resolve at build time, not import time
 *   - tests substitute a fake factory without touching consumer code
 *   - config is validated once, at construction, not on every call
 */

import type { Registry } from './registry.js';

export interface FactoryContext {
  /** Resolves secrets by logical name (Vault/KMS in prod, env in dev). */
  readonly secrets: SecretResolver;
  readonly region: string;
  readonly logger: Logger;
}

export interface SecretResolver {
  get(name: string): Promise<string>;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * @typeParam TProduct - what gets built (e.g. STTProvider)
 * @typeParam TConfig  - the validated config shape for this provider
 */
export interface Factory<TProduct, TConfig = unknown> {
  readonly key: string;
  readonly label: string;
  /** Zod-parsed and defaulted. Throws on invalid config — at build time, not call time. */
  parseConfig(raw: unknown): TConfig;
  create(config: TConfig, ctx: FactoryContext): Promise<TProduct>;
}

/**
 * Builds products by key from a factory registry, with an instance cache.
 *
 * Caching matters: a provider holds pooled HTTP/WS connections and pre-warmed
 * encoders. Rebuilding per call would add handshake latency to every turn — one
 * of the exact costs we're trying to delete.
 */
export class FactoryResolver<TProduct> {
  private readonly cache = new Map<string, Promise<TProduct>>();

  constructor(
    private readonly registry: Registry<Factory<TProduct, any>>,
    private readonly ctx: FactoryContext,
  ) {}

  async build(key: string, rawConfig: unknown = {}): Promise<TProduct> {
    const factory = this.registry.get(key);
    const config = factory.parseConfig(rawConfig);
    const cacheKey = `${key}:${stableHash(config)}`;

    let pending = this.cache.get(cacheKey);
    if (!pending) {
      this.ctx.logger.debug('building provider', { key, cacheKey });
      pending = factory.create(config, this.ctx);
      this.cache.set(cacheKey, pending);
      // Don't cache a rejected build — the next call should retry.
      pending.catch(() => this.cache.delete(cacheKey));
    }
    return pending;
  }

  /** Warm the cache at boot so the first call of the day isn't slow (problem 6.6). */
  async prewarm(specs: Array<{ key: string; config?: unknown }>): Promise<void> {
    await Promise.allSettled(specs.map((s) => this.build(s.key, s.config ?? {})));
  }

  invalidate(): void {
    this.cache.clear();
  }
}

/** Order-insensitive config hash so `{a,b}` and `{b,a}` share a cache slot. */
function stableHash(value: unknown): string {
  const json = JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v as object)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (v as Record<string, unknown>)[k];
            return acc;
          }, {})
      : v,
  );
  let h = 0;
  for (let i = 0; i < json.length; i++) h = (Math.imul(31, h) + json.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
