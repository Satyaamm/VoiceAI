/**
 * Provider registration — the one place that knows which vendors exist.
 *
 * `container.ts` calls `registerProviders(container.registries, ctx)` after the
 * mocks are registered. Everything here is additive: the mocks stay registered
 * so the simulator and eval harness keep working, and they sit at the BOTTOM of
 * each fallback ladder so a total vendor outage degrades to a deterministic
 * pipeline instead of a dead call (docs/03 6.3).
 *
 * The ladder is the Phase 1 shape of ARCHITECTURE.md §7 (self-hosted primary ->
 * self-hosted secondary -> vendor fuse). In Phase 1 we have no self-hosted
 * models yet, so it reads vendor-primary -> vendor-secondary -> mock. When the
 * Parakeet/vLLM/self-hosted-TTS entries land they are inserted at the head of
 * these chains and nothing else changes.
 *
 * Registration NEVER throws on a missing credential. A dev box with no
 * Deepgram key should still boot with mocks; a provider whose secret cannot be
 * resolved is logged and skipped, not fatal.
 */

import type { FallbackRegistry } from '../core/patterns/registry.js';
import type { FactoryContext } from '../core/patterns/factory.js';
import type { LlmProvider, ProviderMeta, SttProvider, TtsProvider } from './types.js';
import type { WebSocketFactory } from './adapters/deepgram.js';
import {
  anthropicLlmFactory,
  cartesiaTtsFactory,
  deepgramSttFactory,
  elevenLabsTtsFactory,
  openAiLlmFactory,
  type ProviderFactory,
} from './factories.js';

export interface ProviderRegistries {
  stt: FallbackRegistry<SttProvider>;
  llm: FallbackRegistry<LlmProvider>;
  tts: FallbackRegistry<TtsProvider>;
}

export interface RegisterProvidersOptions {
  /** Per-provider raw config, keyed by provider key. Zod-validated on build. */
  configs?: Record<string, unknown>;
  /** Runtime WebSocket implementation for Deepgram (see TODO in deepgram.ts). */
  webSocketFactory?: WebSocketFactory;
  /** Skip a provider entirely (e.g. an EU cell that must not hold US keys). */
  exclude?: string[];
  /** Replace an existing registration — used by tests. */
  override?: boolean;
}

export interface RegisteredProvider {
  key: string;
  kind: 'stt' | 'llm' | 'tts';
  registered: boolean;
  reason?: string;
}

/**
 * Language coverage for the LLM tier. Unlike STT/TTS this is not a hard
 * capability list — frontier models handle far more — but docs/13 §4 is about
 * *quality*, and these are the languages we are willing to sell agent behaviour
 * in. Formal/informal register (du/Sie, tu/vous) is handled by our prompt and
 * normalization layer, not by the vendor.
 */
const LLM_LANGUAGES = [
  'en-US',
  'en-GB',
  'de-DE',
  'fr-FR',
  'es-ES',
  'it-IT',
  'nl-NL',
  'pt-PT',
  'pt-BR',
  'pl-PL',
];

/** Priorities: higher wins. Mocks live at 10, so every vendor outranks them. */
const PRIORITY = {
  deepgramStt: 100,
  anthropicLlm: 100,
  openAiLlm: 90,
  cartesiaTts: 100,
  elevenLabsTts: 90,
} as const;

export async function registerProviders(
  registries: ProviderRegistries,
  ctx: FactoryContext,
  options: RegisterProvidersOptions = {},
): Promise<RegisteredProvider[]> {
  const log = ctx.logger.child({ component: 'provider-registration' });
  const excluded = new Set(options.exclude ?? []);
  const configs = options.configs ?? {};
  const results: RegisteredProvider[] = [];

  const build = async <TProduct, TConfig>(
    kind: 'stt' | 'llm' | 'tts',
    registry: FallbackRegistry<TProduct>,
    factory: ProviderFactory<TProduct, TConfig>,
    priority: number,
    languages: string[] | ((product: TProduct) => string[]),
  ): Promise<void> => {
    if (excluded.has(factory.key)) {
      results.push({ key: factory.key, kind, registered: false, reason: 'excluded' });
      return;
    }
    try {
      const config = factory.parseConfig(configs[factory.key] ?? {});
      const product = await factory.create(config, ctx);
      const meta: ProviderMeta = factory.meta(config);
      const resolvedLanguages =
        typeof languages === 'function' ? languages(product) : [...languages];

      registry.register(factory.key, product, {
        label: factory.label,
        priority,
        metadata: {
          ...meta,
          languages: resolvedLanguages,
          // Restated explicitly: the residency filter reads registry metadata,
          // and a missing field would read as "allowed everywhere".
          allowedBlocs: meta.allowedBlocs ?? ['US'],
          selfHosted: meta.selfHosted ?? false,
        },
        ...(options.override ? { override: true } : {}),
      });
      results.push({ key: factory.key, kind, registered: true });
      log.info('registered provider', { key: factory.key, kind, priority });
    } catch (error) {
      // Missing credentials or a bad config must not stop the process from
      // booting — the mocks are still registered and the ladder still resolves.
      const reason = error instanceof Error ? error.message : String(error);
      results.push({ key: factory.key, kind, registered: false, reason });
      log.warn('provider not registered', { key: factory.key, kind, reason });
    }
  };

  await build(
    'stt',
    registries.stt,
    deepgramSttFactory(options.webSocketFactory),
    PRIORITY.deepgramStt,
    (p) => [...p.languages],
  );

  await build('llm', registries.llm, anthropicLlmFactory(), PRIORITY.anthropicLlm, LLM_LANGUAGES);
  await build('llm', registries.llm, openAiLlmFactory(), PRIORITY.openAiLlm, LLM_LANGUAGES);

  await build('tts', registries.tts, cartesiaTtsFactory(), PRIORITY.cartesiaTts, (p) => [
    ...p.languages,
  ]);
  await build('tts', registries.tts, elevenLabsTtsFactory(), PRIORITY.elevenLabsTts, (p) => [
    ...p.languages,
  ]);

  // Fallback ladders. Only keys that actually registered make it in —
  // `setChain` throws on an unknown key, and a boot without an ElevenLabs key
  // is a normal state, not a bug.
  setChainIfPresent(registries.stt, ['deepgram-stt', 'mock-stt']);
  setChainIfPresent(registries.llm, ['anthropic-llm', 'openai-llm', 'mock-llm']);
  setChainIfPresent(registries.tts, ['cartesia-tts', 'elevenlabs-tts', 'mock-tts']);

  log.info('provider registration complete', {
    stt: registries.stt.keys(),
    llm: registries.llm.keys(),
    tts: registries.tts.keys(),
  });

  return results;
}

function setChainIfPresent<T>(registry: FallbackRegistry<T>, preferred: string[]): void {
  const chain = preferred.filter((key) => registry.has(key));
  if (chain.length) registry.setChain(chain);
}

/**
 * Providers a workspace in `bloc` is allowed to use. docs/13 §2: EU data must
 * not egress, so a US-only vendor is not merely deprioritised — it is not
 * selectable. Callers should use this to build the dashboard's dropdowns, so a
 * customer never sees an option they legally cannot pick.
 */
export function providersForBloc<T>(
  registry: FallbackRegistry<T>,
  bloc: 'US' | 'EU',
): Array<{ value: string; label: string; metadata: Record<string, unknown> }> {
  return registry.options().filter((option) => {
    const blocs = option.metadata['allowedBlocs'];
    if (!Array.isArray(blocs)) return false; // unmarked provider = not selectable
    return blocs.includes(bloc);
  });
}
