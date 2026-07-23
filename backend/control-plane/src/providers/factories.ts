/**
 * Provider factories.
 *
 * One `Factory<TProduct, TConfig>` per adapter. Three rules, all load-bearing:
 *
 *   1. Config is Zod-parsed once, at build time. An agent row in Postgres can
 *      name a provider and pass settings, and a bad setting fails at
 *      construction — not on a live call.
 *   2. Credentials resolve through `ctx.secrets`, NEVER `process.env`. A
 *      provider that reads the environment directly cannot be rotated, cannot
 *      be scoped per-region, and leaks the composition root into the hot path.
 *   3. Every factory publishes `ProviderMeta`, including `allowedBlocs`. A
 *      US-only vendor is marked US-only here, so an EU-residency workspace
 *      (docs/13 §2 — EU data never egresses) cannot select it. This is a data
 *      statement about the vendor, not a preference.
 */

import { z } from 'zod';
import type { Factory, FactoryContext } from '../core/patterns/factory.js';
import type { LlmProvider, ProviderMeta, SttProvider, TtsProvider } from './types.js';
import {
  createDeepgramStt,
  type DeepgramSttOptions,
  type WebSocketFactory,
} from './adapters/deepgram.js';
import { ANTHROPIC_MODELS, createAnthropicLlm } from './adapters/anthropic-llm.js';
import { createOpenAiLlm } from './adapters/openai-llm.js';
import { createCartesiaTts } from './adapters/cartesia-tts.js';
import { createElevenLabsTts } from './adapters/elevenlabs-tts.js';

/**
 * A Factory that also declares where its product may legally run and what it
 * costs. The registry copies this into entry metadata.
 */
export interface ProviderFactory<TProduct, TConfig> extends Factory<TProduct, TConfig> {
  meta(config: TConfig): ProviderMeta;
}

// ---------------------------------------------------------------------------
// Deepgram STT
// ---------------------------------------------------------------------------

export const deepgramConfigSchema = z.object({
  /** Logical secret name, resolved via ctx.secrets. Never a literal key. */
  secretName: z.string().min(1).default('deepgram.apiKey'),
  model: z.string().min(1).default('nova-3'),
  baseUrl: z.string().url().default('wss://api.deepgram.com'),
  /** Vendor-side endpointing. Ours (docs/05) is the one that matters. */
  endpointingMs: z.number().int().min(10).max(2_000).default(300),
  smartFormat: z.boolean().default(true),
});

export type DeepgramConfig = z.infer<typeof deepgramConfigSchema>;

export function deepgramSttFactory(
  webSocketFactory?: WebSocketFactory,
): ProviderFactory<SttProvider, DeepgramConfig> {
  return {
    key: 'deepgram-stt',
    label: 'Deepgram (streaming STT)',
    parseConfig: (raw) => deepgramConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      const opts: DeepgramSttOptions = {
        apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        endpointingMs: config.endpointingMs,
        smartFormat: config.smartFormat,
        ...(webSocketFactory ? { webSocketFactory } : {}),
      };
      return createDeepgramStt(opts);
    },
    meta: () => ({
      costPerMinuteUsd: 0.006, // docs/04 Phase 1 cost table
      typicalTtfbMs: 180, // first interim result
      // Hosted Deepgram is US-processed. EU means self-hosting their runtime,
      // which is a different provider entry, not a config flag.
      allowedBlocs: ['US'],
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// OpenAI LLM
// ---------------------------------------------------------------------------

export const openAiConfigSchema = z.object({
  secretName: z.string().min(1).default('openai.apiKey'),
  /** 'global' = api.openai.com (US-processed); 'eu' = EU residency host. */
  residency: z.enum(['global', 'eu']).default('global'),
  baseUrl: z.string().url().optional(),
  models: z.array(z.string().min(1)).nonempty().default(['gpt-4o-mini', 'gpt-4o']),
  organization: z.string().min(1).optional(),
  usePromptCacheKey: z.boolean().default(true),
});

export type OpenAiConfig = z.infer<typeof openAiConfigSchema>;

function openAiBaseUrl(config: OpenAiConfig): string {
  if (config.baseUrl) return config.baseUrl;
  return config.residency === 'eu' ? 'https://eu.api.openai.com' : 'https://api.openai.com';
}

export function openAiLlmFactory(): ProviderFactory<LlmProvider, OpenAiConfig> {
  return {
    key: 'openai-llm',
    label: 'OpenAI (streaming chat)',
    parseConfig: (raw) => openAiConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createOpenAiLlm({
        apiKey,
        baseUrl: openAiBaseUrl(config),
        models: [...config.models],
        usePromptCacheKey: config.usePromptCacheKey,
        ...(config.organization ? { organization: config.organization } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.02, // ~8 turns/min, docs/04
      typicalTtfbMs: 380, // cold prefix; ~180ms warm (docs/01 §5)
      // Residency is not a preference we can override — the default host is
      // US-processed, so only the EU host earns the EU bloc.
      allowedBlocs: config.residency === 'eu' ? ['EU'] : ['US'],
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Anthropic LLM
// ---------------------------------------------------------------------------

export const anthropicConfigSchema = z.object({
  secretName: z.string().min(1).default('anthropic.apiKey'),
  baseUrl: z.string().url().default('https://api.anthropic.com'),
  models: z.array(z.string().min(1)).nonempty().default(ANTHROPIC_MODELS as [string, ...string[]]),
  maxTokens: z.number().int().min(64).max(4_096).default(512),
  /** Explicit prefix-cache breakpoint — the docs/01 §5 lever. */
  promptCaching: z.boolean().default(true),
  inferenceGeo: z.enum(['us', 'eu']).optional(),
});

export type AnthropicConfig = z.infer<typeof anthropicConfigSchema>;

export function anthropicLlmFactory(): ProviderFactory<LlmProvider, AnthropicConfig> {
  return {
    key: 'anthropic-llm',
    label: 'Anthropic Claude (streaming chat)',
    parseConfig: (raw) => anthropicConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createAnthropicLlm({
        apiKey,
        baseUrl: config.baseUrl,
        models: [...config.models],
        maxTokens: config.maxTokens,
        promptCaching: config.promptCaching,
        ...(config.inferenceGeo ? { inferenceGeo: config.inferenceGeo } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.02,
      // Warm prefix caching is what makes this viable on a phone call: cold
      // prefill on a ~4k-token agent prompt is ~400ms, warm is ~150ms.
      typicalTtfbMs: 400,
      allowedBlocs: config.inferenceGeo === 'eu' ? ['EU'] : ['US'],
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Cartesia TTS
// ---------------------------------------------------------------------------

export const cartesiaConfigSchema = z.object({
  secretName: z.string().min(1).default('cartesia.apiKey'),
  baseUrl: z.string().url().default('https://api.cartesia.ai'),
  modelId: z.string().min(1).default('sonic-2'),
  sampleRate: z.number().int().min(8_000).max(48_000).default(16_000),
});

export type CartesiaConfig = z.infer<typeof cartesiaConfigSchema>;

export function cartesiaTtsFactory(): ProviderFactory<TtsProvider, CartesiaConfig> {
  return {
    key: 'cartesia-tts',
    label: 'Cartesia Sonic (streaming TTS)',
    parseConfig: (raw) => cartesiaConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createCartesiaTts({
        apiKey,
        baseUrl: config.baseUrl,
        modelId: config.modelId,
        sampleRate: config.sampleRate,
      });
    },
    meta: () => ({
      costPerMinuteUsd: 0.03, // ~38% speaking duty cycle, docs/04
      typicalTtfbMs: 90, // the reason docs/04 picks it as primary
      allowedBlocs: ['US'], // US-hosted only
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------

export const elevenLabsConfigSchema = z.object({
  secretName: z.string().min(1).default('elevenlabs.apiKey'),
  /** 'global' is US-processed; 'eu' selects the EU residency host. */
  residency: z.enum(['global', 'eu']).default('global'),
  baseUrl: z.string().url().optional(),
  modelId: z.string().min(1).default('eleven_flash_v2_5'),
  sampleRate: z.union([
    z.literal(8_000),
    z.literal(16_000),
    z.literal(22_050),
    z.literal(24_000),
    z.literal(44_100),
  ]).default(16_000),
  stability: z.number().min(0).max(1).default(0.5),
  similarityBoost: z.number().min(0).max(1).default(0.75),
});

export type ElevenLabsConfig = z.infer<typeof elevenLabsConfigSchema>;

function elevenLabsBaseUrl(config: ElevenLabsConfig): string {
  if (config.baseUrl) return config.baseUrl;
  return config.residency === 'eu'
    ? 'https://api.eu.residency.elevenlabs.io'
    : 'https://api.elevenlabs.io';
}

export function elevenLabsTtsFactory(): ProviderFactory<TtsProvider, ElevenLabsConfig> {
  return {
    key: 'elevenlabs-tts',
    label: 'ElevenLabs (streaming TTS)',
    parseConfig: (raw) => elevenLabsConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createElevenLabsTts({
        apiKey,
        baseUrl: elevenLabsBaseUrl(config),
        modelId: config.modelId,
        sampleRate: config.sampleRate,
        stability: config.stability,
        similarityBoost: config.similarityBoost,
      });
    },
    meta: (config) => ({
      // Roughly 2-3x Cartesia. TTS is the biggest per-minute line (docs/04),
      // which is exactly why this is the fallback and not the primary.
      costPerMinuteUsd: 0.075,
      typicalTtfbMs: config.modelId.includes('flash') ? 160 : 320,
      allowedBlocs: config.residency === 'eu' ? ['EU'] : ['US'],
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------

/** Convenience for callers that just want everything, unconfigured. */
export function allProviderFactories(webSocketFactory?: WebSocketFactory) {
  return {
    stt: [deepgramSttFactory(webSocketFactory)],
    llm: [anthropicLlmFactory(), openAiLlmFactory()],
    tts: [cartesiaTtsFactory(), elevenLabsTtsFactory()],
  } as const;
}

/** Re-exported so `container.ts` can type its factory context without digging. */
export type { FactoryContext };
