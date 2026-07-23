/**
 * Agent service.
 *
 * Two rules worth stating: agent versions are immutable, and publishing is the only
 * thing that increments a version. Every call records the exact version it ran, so
 * "which prompt produced this behaviour?" is always answerable (docs/03 6.7).
 */

import { newId } from '../domain/ids.js';
import type { z } from 'zod';
import {
  agentSchema,
  pipelineConfigSchema,
  voiceConfigSchema,
  type updateAgentInput,
  type Agent,
  type CreateAgentInput,
} from '../domain/schemas.js';

type UpdateAgentInput = z.infer<typeof updateAgentInput>;
import { require_, type WorkspaceScope } from '../domain/tenant.js';
import {
  ConflictError,
  NotFoundError,
  type AgentRepository,
  type ListOptions,
  type WorkspaceRepository,
} from '../repositories/types.js';

/** Sensible starting pipeline. Speculative prefill and semantic endpointing ON by default —
 *  the whole latency thesis is worthless if the defaults are the slow path. */
const DEFAULT_PIPELINE = {
  sttProvider: 'mock-stt',
  llmProvider: 'mock-llm',
  llmModel: 'mock-fast',
  ttsProvider: 'mock-tts',
  endpointingStrategy: 'semantic',
  bargeInStrategy: 'target-speaker',
  temperature: 0.3,
  maxTokens: 300,
  speculativePrefill: true,
  fillerEnabled: true,
};

const DEFAULT_VOICE = {
  providerKey: 'mock-tts',
  voiceId: 'mock-en-f',
  speed: 1,
  lexicon: [],
};

export interface AgentVersionRecord {
  id: string;
  agentId: string;
  version: number;
  publishedAt: string;
  publishedBy: string;
  changeNote?: string;
  snapshot: Pick<Agent, 'prompt' | 'voice' | 'pipeline' | 'tools' | 'language'>;
}

export class AgentService {
  /** Version history. Postgres table in production; in-memory for Phase 1. */
  private readonly versions = new Map<string, AgentVersionRecord[]>();

  constructor(
    private readonly agents: AgentRepository,
    private readonly workspaces: WorkspaceRepository,
  ) {}

  async list(scope: WorkspaceScope, opts?: ListOptions) {
    require_(scope, 'agent:read');
    return this.agents.list(scope, opts);
  }

  async get(scope: WorkspaceScope, agentId: string): Promise<Agent> {
    require_(scope, 'agent:read');
    const agent = await this.agents.get(scope, agentId);
    if (!agent) throw new NotFoundError('agent', agentId);
    return agent;
  }

  async create(scope: WorkspaceScope, input: CreateAgentInput): Promise<Agent> {
    require_(scope, 'agent:write');

    const workspace = await this.workspaces.get(scope, scope.workspaceId);
    if (!workspace) throw new NotFoundError('workspace', scope.workspaceId);

    const now = new Date().toISOString();
    const agent = agentSchema.parse({
      id: newId('agent'),
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      name: input.name,
      status: 'draft',
      version: 1,
      description: input.description ?? '',
      language: input.language ?? 'en-US',
      prompt: input.prompt,
      voice: voiceConfigSchema.parse({ ...DEFAULT_VOICE, ...(input.voice ?? {}) }),
      pipeline: pipelineConfigSchema.parse({ ...DEFAULT_PIPELINE, ...(input.pipeline ?? {}) }),
      tools: [],
      createdAt: now,
      updatedAt: now,
      stats: {
        callsToday: 0,
        successRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        avgDurationSec: 0,
        costPerCallUsd: 0,
      },
    } satisfies Agent);

    return this.agents.create(scope, agent);
  }

  /**
   * Edits apply to the DRAFT. A live agent keeps serving its published version
   * until someone publishes again — editing a prompt must never change behaviour
   * on calls already in flight.
   */
  async update(
    scope: WorkspaceScope,
    agentId: string,
    patch: UpdateAgentInput,
  ): Promise<Agent> {
    require_(scope, 'agent:write');
    const existing = await this.get(scope, agentId);

    // Only these fields are client-writable. Version, status, stats and tenancy
    // are system-owned and are simply not part of the input type.
    const merged: Partial<Agent> = {};
    if (patch.name !== undefined) merged.name = patch.name;
    if (patch.description !== undefined) merged.description = patch.description;
    if (patch.language !== undefined) merged.language = patch.language;
    if (patch.prompt !== undefined) merged.prompt = patch.prompt;

    // Nested config merges rather than replaces.
    if (patch.voice) merged.voice = voiceConfigSchema.parse({ ...existing.voice, ...patch.voice });
    if (patch.pipeline) {
      merged.pipeline = pipelineConfigSchema.parse({ ...existing.pipeline, ...patch.pipeline });
    }

    return this.agents.update(scope, agentId, merged);
  }

  /**
   * Publish: snapshot the current config as an immutable version, bump the counter,
   * and mark the agent live.
   */
  async publish(
    scope: WorkspaceScope,
    agentId: string,
    changeNote?: string,
  ): Promise<{ agent: Agent; version: AgentVersionRecord }> {
    require_(scope, 'agent:publish');
    const agent = await this.get(scope, agentId);

    if (agent.status === 'archived') {
      throw new ConflictError('cannot publish an archived agent');
    }

    const nextVersion = agent.version + 1;
    const record: AgentVersionRecord = {
      id: newId('agentVersion'),
      agentId,
      version: nextVersion,
      publishedAt: new Date().toISOString(),
      publishedBy: scope.userId,
      changeNote,
      snapshot: {
        prompt: agent.prompt,
        voice: agent.voice,
        pipeline: agent.pipeline,
        tools: agent.tools,
        language: agent.language,
      },
    };

    const history = this.versions.get(agentId) ?? [];
    history.push(record);
    this.versions.set(agentId, history);

    const updated = await this.agents.update(scope, agentId, {
      version: nextVersion,
      status: 'live',
    });
    return { agent: updated, version: record };
  }

  async listVersions(scope: WorkspaceScope, agentId: string): Promise<AgentVersionRecord[]> {
    require_(scope, 'agent:read');
    await this.get(scope, agentId); // scope check
    return [...(this.versions.get(agentId) ?? [])].sort((a, b) => b.version - a.version);
  }

  /** Restore a previous version's config into the draft. Never rewrites history. */
  async rollback(scope: WorkspaceScope, agentId: string, toVersion: number): Promise<Agent> {
    require_(scope, 'agent:publish');
    await this.get(scope, agentId);
    const record = (this.versions.get(agentId) ?? []).find((v) => v.version === toVersion);
    if (!record) throw new NotFoundError('agent version', `${agentId}@${toVersion}`);

    return this.agents.update(scope, agentId, { ...record.snapshot });
  }

  async delete(scope: WorkspaceScope, agentId: string): Promise<void> {
    require_(scope, 'agent:write');
    await this.get(scope, agentId);
    // Soft delete: call records reference this agent and must stay resolvable.
    await this.agents.update(scope, agentId, { status: 'archived' });
  }
}
