/**
 * Anthropic (Claude) Messages API adapter — streaming, tool calling.
 *
 * docs/04 names "Claude / GPT" as the Phase 1 LLM fuse. Both sit behind the
 * same `LlmProvider`, so the Phase 2 vLLM swap is a registry change.
 *
 * PREFIX CACHING (docs/01 §5) — the reason this adapter is more than a fetch
 * call. Claude's cache is EXPLICIT: you mark a breakpoint with
 * `cache_control: {type: 'ephemeral'}` and everything before it is cached.
 * Render order is tools -> system -> messages, so a breakpoint on the last
 * system block caches the tool schemas and the system prompt together — for a
 * voice agent that is the whole ~4,000-token prefill, replayed every turn.
 * The hit shows up as `usage.cache_read_input_tokens` and is surfaced as
 * `cachedTokens` on the `done` delta.
 *
 * The cache is a byte-prefix match, so the caller MUST keep the system prompt
 * and tool list stable per agent (that is what `cacheKey` scopes). Interpolate
 * a timestamp into the system prompt and the cache silently never hits.
 *
 * LATENCY: thinking is explicitly disabled on models that support the flag.
 * A voice turn has a ~320ms budget; adaptive thinking is the wrong trade here.
 *
 * RESIDENCY: default processing is US. `inferenceGeo: 'eu'` requests EU
 * inference; the factory only widens `allowedBlocs` when it is set.
 */

import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../types.js';

/**
 * Model IDs are exact strings — never append a date suffix.
 * - claude-haiku-4-5 : the voice default. Cheapest, lowest TTFT.
 * - claude-sonnet-5  : escalation for harder reasoning turns.
 * - claude-opus-4-8  : offline eval / hardest turns; too slow for the hot path.
 */
export const ANTHROPIC_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];

/** Sampling params (temperature/top_p/top_k) return 400 on these models. */
const NO_SAMPLING_PARAMS = new Set(['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5']);

/** Models that accept an explicit `thinking: {type:'disabled'}`. */
const SUPPORTS_THINKING_FLAG = new Set([
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);

const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicLlmOptions {
  apiKey: string;
  baseUrl: string;
  models: string[];
  /** Default output cap. Voice replies are short; a big cap only risks runaway. */
  maxTokens: number;
  /** Turn on the explicit prefix-cache breakpoint. */
  promptCaching: boolean;
  /** Data-residency hint for inference. Undefined = provider default (US). */
  inferenceGeo?: 'us' | 'eu';
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly key = 'anthropic-llm';
  readonly label = 'Anthropic Claude (streaming chat)';
  readonly models: string[];

  constructor(private readonly opts: AnthropicLlmOptions) {
    this.models = [...opts.models];
  }

  async *stream(streamOpts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    cacheKey?: string;
    signal?: AbortSignal;
  }): AsyncIterable<LlmDelta> {
    if (streamOpts.signal?.aborted) return;

    const { system, messages } = splitSystem(streamOpts.messages);

    const body: Record<string, unknown> = {
      model: streamOpts.model,
      max_tokens: streamOpts.maxTokens ?? this.opts.maxTokens,
      messages,
      stream: true,
    };

    if (system.length) {
      // Breakpoint on the LAST system block: caches tools + system in one go.
      body['system'] = system.map((text, i) => ({
        type: 'text',
        text,
        ...(this.opts.promptCaching && i === system.length - 1
          ? { cache_control: { type: 'ephemeral' } }
          : {}),
      }));
    }

    if (streamOpts.tools?.length) {
      body['tools'] = streamOpts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    if (streamOpts.temperature !== undefined && !NO_SAMPLING_PARAMS.has(streamOpts.model)) {
      body['temperature'] = streamOpts.temperature;
    }
    if (SUPPORTS_THINKING_FLAG.has(streamOpts.model)) {
      body['thinking'] = { type: 'disabled' };
    }
    if (this.opts.inferenceGeo) {
      // Top-level request parameter, not a header and not extra_body.
      body['inference_geo'] = this.opts.inferenceGeo;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };

    // Network failures throw; the CircuitBreaker owns the fallback decision.
    const response = await fetch(new URL('/v1/messages', this.opts.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`anthropic: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;

    /** index -> in-flight tool_use block. `input_json_delta` arrives in pieces. */
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>();

    for await (const raw of sseEvents(response.body, streamOpts.signal)) {
      if (streamOpts.signal?.aborted) return; // barge-in
      const event = parseJson(raw);
      if (!event) continue;
      const type = event['type'];

      if (type === 'error') {
        const err = event['error'];
        const message =
          err && typeof err === 'object'
            ? String((err as Record<string, unknown>)['message'] ?? 'stream error')
            : 'stream error';
        throw new Error(`anthropic: ${message}`);
      }

      if (type === 'message_start') {
        const message = event['message'];
        if (message && typeof message === 'object') {
          const usage = (message as Record<string, unknown>)['usage'];
          if (usage && typeof usage === 'object') {
            const u = usage as Record<string, unknown>;
            const input = num(u['input_tokens'], 0);
            const created = num(u['cache_creation_input_tokens'], 0);
            const read = num(u['cache_read_input_tokens'], 0);
            // `input_tokens` is the UNCACHED remainder only — the real prompt
            // size is the sum. Reporting only input_tokens would make a warm
            // agent look like it had a 40-token prompt.
            promptTokens = input + created + read;
            cachedTokens = read;
            completionTokens = num(u['output_tokens'], 0);
          }
        }
        continue;
      }

      if (type === 'content_block_start') {
        const index = num(event['index'], 0);
        const block = event['content_block'];
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_use') {
            toolBlocks.set(index, {
              id: str(b['id']),
              name: str(b['name']),
              args: '',
            });
          }
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const index = num(event['index'], 0);
        const delta = event['delta'];
        if (!delta || typeof delta !== 'object') continue;
        const d = delta as Record<string, unknown>;
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string' && d['text']) {
          yield { type: 'text', text: d['text'] };
        } else if (d['type'] === 'input_json_delta' && typeof d['partial_json'] === 'string') {
          const block = toolBlocks.get(index);
          if (block) block.args += d['partial_json'];
        }
        continue;
      }

      if (type === 'content_block_stop') {
        const index = num(event['index'], 0);
        const block = toolBlocks.get(index);
        if (block && block.name) {
          toolBlocks.delete(index);
          // Emitted only once the JSON is complete — a half-parsed tool call
          // is not executable.
          yield {
            type: 'tool_call',
            id: block.id || block.name,
            name: block.name,
            arguments: block.args || '{}',
          };
        }
        continue;
      }

      if (type === 'message_delta') {
        const usage = event['usage'];
        if (usage && typeof usage === 'object') {
          completionTokens = num(
            (usage as Record<string, unknown>)['output_tokens'],
            completionTokens,
          );
        }
        continue;
      }
    }

    if (streamOpts.signal?.aborted) return;

    yield { type: 'done', usage: { promptTokens, cachedTokens, completionTokens } };
  }
}

/**
 * Claude takes `system` as a top-level field, not a message role. Tool results
 * are `tool_result` content blocks on a user turn.
 */
function splitSystem(messages: ChatMessage[]): {
  system: string[];
  messages: Array<Record<string, unknown>>;
} {
  const system: string[] = [];
  const out: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.content,
          },
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }

  return { system, messages: out };
}

// --- SSE plumbing ----------------------------------------------------------

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) yield data;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export function createAnthropicLlm(opts: AnthropicLlmOptions): AnthropicLlmProvider {
  return new AnthropicLlmProvider(opts);
}
