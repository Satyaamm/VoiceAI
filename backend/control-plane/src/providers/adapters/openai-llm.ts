/**
 * OpenAI chat-completions adapter (streaming, tool calling).
 *
 * docs/04: the LLM is bought in Phase 1 and self-hosted (vLLM) in Phase 2. The
 * only thing that must survive that swap is this interface — so nothing above
 * this file knows what SSE looks like.
 *
 * PREFIX CACHING (docs/01 §5): OpenAI's cache is *automatic* for prompts over
 * ~1024 tokens — there is no `cache_control` to set. What we can control is
 * making the prefix byte-identical across turns of the same agent, so we sort
 * nothing, reorder nothing, and keep system + tools first. The hit count comes
 * back as `usage.prompt_tokens_details.cached_tokens` and is reported as
 * `cachedTokens` on the `done` delta, because that number is the latency and
 * cost lever the Cost Governor reasons about.
 *
 * RESIDENCY: the default api.openai.com is US-processed. EU data residency is
 * an enterprise feature on a separate host, so the factory switches both the
 * base URL and `allowedBlocs` together — you cannot get one without the other.
 */

import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../types.js';

export interface OpenAiLlmOptions {
  apiKey: string;
  baseUrl: string;
  models: string[];
  organization?: string;
  /** Sent as `prompt_cache_key`; scopes the automatic prefix cache per agent. */
  usePromptCacheKey: boolean;
}

interface StreamedToolCall {
  id: string;
  name: string;
  args: string;
  emitted: boolean;
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly key = 'openai-llm';
  readonly label = 'OpenAI (streaming chat)';
  readonly models: string[];

  constructor(private readonly opts: OpenAiLlmOptions) {
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

    const body: Record<string, unknown> = {
      model: streamOpts.model,
      messages: streamOpts.messages.map(toOpenAiMessage),
      stream: true,
      // Without this the final chunk carries no usage, and we lose the cache
      // hit count — i.e. we lose the metric docs/01 §5 is about.
      stream_options: { include_usage: true },
    };
    if (streamOpts.temperature !== undefined) body['temperature'] = streamOpts.temperature;
    if (streamOpts.maxTokens !== undefined) body['max_tokens'] = streamOpts.maxTokens;
    if (streamOpts.tools?.length) {
      body['tools'] = streamOpts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }
    if (this.opts.usePromptCacheKey && streamOpts.cacheKey) {
      body['prompt_cache_key'] = streamOpts.cacheKey;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.apiKey}`,
    };
    if (this.opts.organization) headers['openai-organization'] = this.opts.organization;

    // Network failures throw. The CircuitBreaker wraps this call and walks the
    // fallback ladder — swallowing here would hide an outage.
    const response = await fetch(new URL('/v1/chat/completions', this.opts.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`openai: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    const toolCalls = new Map<number, StreamedToolCall>();
    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;

    for await (const event of sseEvents(response.body, streamOpts.signal)) {
      if (streamOpts.signal?.aborted) return; // barge-in
      if (event === '[DONE]') break;

      const chunk = parseJson(event);
      if (!chunk) continue;

      const usage = chunk['usage'];
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        promptTokens = num(u['prompt_tokens'], promptTokens);
        completionTokens = num(u['completion_tokens'], completionTokens);
        const details = u['prompt_tokens_details'];
        if (details && typeof details === 'object') {
          cachedTokens = num((details as Record<string, unknown>)['cached_tokens'], cachedTokens);
        }
      }

      const choices = chunk['choices'];
      if (!Array.isArray(choices)) continue;
      const choice = choices[0];
      if (!choice || typeof choice !== 'object') continue;
      const delta = (choice as Record<string, unknown>)['delta'];
      const finish = (choice as Record<string, unknown>)['finish_reason'];

      if (delta && typeof delta === 'object') {
        const d = delta as Record<string, unknown>;
        const text = d['content'];
        if (typeof text === 'string' && text.length > 0) {
          yield { type: 'text', text };
        }
        const calls = d['tool_calls'];
        if (Array.isArray(calls)) {
          for (const raw of calls) {
            if (!raw || typeof raw !== 'object') continue;
            const c = raw as Record<string, unknown>;
            const index = num(c['index'], 0);
            const existing = toolCalls.get(index) ?? {
              id: '',
              name: '',
              args: '',
              emitted: false,
            };
            if (typeof c['id'] === 'string') existing.id = c['id'];
            const fn = c['function'];
            if (fn && typeof fn === 'object') {
              const f = fn as Record<string, unknown>;
              if (typeof f['name'] === 'string') existing.name += f['name'];
              if (typeof f['arguments'] === 'string') existing.args += f['arguments'];
            }
            toolCalls.set(index, existing);
          }
        }
      }

      // Arguments arrive as a JSON fragment stream; a partial call is not
      // executable, so we emit each call once its arguments are complete.
      if (typeof finish === 'string' && finish.length > 0) {
        for (const call of toolCalls.values()) {
          if (call.emitted || !call.name) continue;
          call.emitted = true;
          yield {
            type: 'tool_call',
            id: call.id || `${call.name}-${toolCalls.size}`,
            name: call.name,
            arguments: call.args || '{}',
          };
        }
      }
    }

    if (streamOpts.signal?.aborted) return;

    for (const call of toolCalls.values()) {
      if (call.emitted || !call.name) continue;
      call.emitted = true;
      yield {
        type: 'tool_call',
        id: call.id || call.name,
        name: call.name,
        arguments: call.args || '{}',
      };
    }

    yield {
      type: 'done',
      usage: { promptTokens, cachedTokens, completionTokens },
    };
  }
}

function toOpenAiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
  }
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name) out['name'] = m.name;
  return out;
}

// --- SSE plumbing ----------------------------------------------------------
// Deliberately duplicated in anthropic-llm.ts rather than shared: these two
// adapters must be independently deletable when the self-hosted path lands.

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
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) yield data;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Cancelling the reader is what actually stops the socket on barge-in.
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

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export function createOpenAiLlm(opts: OpenAiLlmOptions): OpenAiLlmProvider {
  return new OpenAiLlmProvider(opts);
}
