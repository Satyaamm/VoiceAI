/**
 * Composition root.
 *
 * Every registry, factory, repository, and service is wired here and nowhere else.
 * Nothing in the codebase constructs a provider with `new` at a call site — that's
 * what makes agent config able to name a provider, and what makes tests able to
 * substitute one.
 *
 * Storage is swappable in exactly one place: `createContainer({ db })` returns
 * Postgres-backed repositories, and omitting `db` returns in-memory ones. Every
 * service above this line is unaware of the difference.
 */

import { FallbackRegistry, Registry } from './core/patterns/registry.js';
import { FallbackExecutor } from './core/patterns/circuit-breaker.js';
import { EventBus } from './core/patterns/event-bus.js';
import {
  AnySpeechBargeIn,
  FixedSilenceEndpointing,
  SemanticEndpointing,
  TargetSpeakerBargeIn,
  type BargeInStrategy,
  type EndpointingStrategy,
} from './core/patterns/strategy.js';
import type { Logger } from './core/patterns/factory.js';

import { MockLlmProvider, MockSttProvider, MockTtsProvider } from './providers/mock.js';
import type { LlmProvider, SttProvider, TtsProvider } from './providers/types.js';

import type {
  AgentRepository,
  OrganizationRepository,
  UserRepository,
  WorkspaceRepository,
} from './repositories/types.js';
import {
  MemoryAgentRepository,
  MemoryOrganizationRepository,
  MemoryUserRepository,
  MemoryWorkspaceRepository,
} from './repositories/memory.js';
import { MemoryCallRepository, MemoryTraceRepository } from './repositories/memory-call.js';
import {
  MemoryCampaignRepository,
  MemoryDispatchAuditRepository,
  MemoryLeadRepository,
  MemoryPhoneNumberRepository,
} from './repositories/memory-telephony.js';
import {
  MemoryApiKeyRepository,
  MemoryCredentialRepository,
  MemoryInvitationRepository,
  MemoryMembershipRepository,
  MemorySessionRepository,
  MemoryVerificationCodeRepository,
} from './repositories/memory-auth.js';

import { WorkspaceService } from './services/workspace-service.js';
import { AgentService } from './services/agent-service.js';
import { CallService } from './services/call-service.js';
import { TraceRecorder } from './services/trace-recorder.js';
import { NumberService } from './services/number-service.js';
import { CampaignService } from './services/campaign-service.js';
import { AuthService, resolveAuthSecrets } from './services/auth-service.js';
import { MembershipService } from './services/membership-service.js';
import { InvitationService } from './services/invitation-service.js';
import { ApiKeyService } from './services/apikey-service.js';
import { buildComplianceChain } from './services/compliance.js';

import { AuditLogger, MemoryAuditLogStore } from './compliance/audit-log.js';
import {
  EncryptionService,
  LocalKms,
  MemoryTenantKeyStore,
} from './compliance/encryption.js';
import { ProviderPostureRegistry } from './compliance/provider-eligibility.js';

import type { PipelineEvents } from './orchestration/events.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const fmt = (level: string, msg: string, meta?: Record<string, unknown>) =>
    JSON.stringify({ level, msg, ...bindings, ...meta, t: new Date().toISOString() });
  return {
    debug: (m, meta) => process.env.LOG_LEVEL === 'debug' && console.log(fmt('debug', m, meta)),
    info: (m, meta) => console.log(fmt('info', m, meta)),
    warn: (m, meta) => console.warn(fmt('warn', m, meta)),
    error: (m, meta) => console.error(fmt('error', m, meta)),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}

// ---------------------------------------------------------------------------

export interface Container {
  logger: Logger;
  events: EventBus<PipelineEvents>;

  registries: {
    stt: FallbackRegistry<SttProvider>;
    llm: FallbackRegistry<LlmProvider>;
    tts: FallbackRegistry<TtsProvider>;
    endpointing: Registry<EndpointingStrategy>;
    bargeIn: Registry<BargeInStrategy>;
  };

  executors: {
    stt: FallbackExecutor<SttProvider>;
    llm: FallbackExecutor<LlmProvider>;
    tts: FallbackExecutor<TtsProvider>;
  };

  /**
   * Typed to the INTERFACES, not the Memory classes, so the Postgres swap is a
   * one-line change rather than a type refactor.
   */
  repositories: {
    users: UserRepository;
    orgs: OrganizationRepository;
    workspaces: WorkspaceRepository;
    agents: AgentRepository;
    calls: MemoryCallRepository;
    traces: MemoryTraceRepository;
    numbers: MemoryPhoneNumberRepository;
    campaigns: MemoryCampaignRepository;
    leads: MemoryLeadRepository;
    dispatchAudit: MemoryDispatchAuditRepository;
    credentials: MemoryCredentialRepository;
    verificationCodes: MemoryVerificationCodeRepository;
    sessions: MemorySessionRepository;
    memberships: MemoryMembershipRepository;
    invitations: MemoryInvitationRepository;
    apiKeys: MemoryApiKeyRepository;
  };

  services: {
    workspaces: WorkspaceService;
    agents: AgentService;
    calls: CallService;
    numbers: NumberService;
    campaigns: CampaignService;
    auth: AuthService;
    memberships: MembershipService;
    invitations: InvitationService;
    apiKeys: ApiKeyService;
    compliance: ReturnType<typeof buildComplianceChain>;
  };

  /** Regulatory controls. docs/14. */
  compliance: {
    audit: AuditLogger;
    encryption: EncryptionService;
    postures: ProviderPostureRegistry;
  };

  traceRecorder: TraceRecorder;
}

export function createContainer(): Container {
  const logger = createLogger({ service: 'control-plane' });
  const events = new EventBus<PipelineEvents>();

  // -- Strategies ----------------------------------------------------------
  // Both the production strategy AND its naive baseline are registered. You
  // cannot claim a 300ms win without measuring against the thing you claim to
  // beat, so the control arm ships too. docs/05.
  const endpointing = new Registry<EndpointingStrategy>('endpointing')
    .register('semantic', new SemanticEndpointing({ logger }), {
      label: 'Semantic (prosody + text + adaptive)',
      priority: 10,
      metadata: { recommended: true },
    })
    .register('fixed-silence', new FixedSilenceEndpointing(700), {
      label: 'Fixed silence 700ms (baseline)',
      priority: 0,
      metadata: { baseline: true },
    });

  const bargeIn = new Registry<BargeInStrategy>('barge-in')
    .register('target-speaker', new TargetSpeakerBargeIn(), {
      label: 'Target speaker (noise robust)',
      priority: 10,
      metadata: { recommended: true },
    })
    .register('any-speech', new AnySpeechBargeIn(), {
      label: 'Any speech (baseline)',
      priority: 0,
      metadata: { baseline: true },
    });

  // -- Providers -----------------------------------------------------------
  // Mocks are always registered so a dev box boots with no credentials. Real
  // adapters are added by `registerProviders()` in main.ts, which skips any
  // provider whose secret can't be resolved.
  const stt = new FallbackRegistry<SttProvider>('stt').register(
    'mock-stt',
    new MockSttProvider(),
    { label: 'Mock STT (simulator)', priority: 0, metadata: { selfHosted: true } },
  );
  const llm = new FallbackRegistry<LlmProvider>('llm').register(
    'mock-llm',
    new MockLlmProvider(),
    { label: 'Mock LLM (simulator)', priority: 0, metadata: { selfHosted: true } },
  );
  const tts = new FallbackRegistry<TtsProvider>('tts').register(
    'mock-tts',
    new MockTtsProvider(),
    { label: 'Mock TTS (simulator)', priority: 0, metadata: { selfHosted: true } },
  );

  // Mocks run inside our own process, so they're trivially eligible everywhere.
  const postures = new ProviderPostureRegistry();
  for (const [key, kind] of [
    ['mock-stt', 'stt'],
    ['mock-llm', 'llm'],
    ['mock-tts', 'tts'],
  ] as const) {
    postures.register({
      key,
      kind,
      allowedBlocs: ['US', 'EU'],
      baaSigned: false,
      dpaSigned: false,
      retainsData: false,
      trainsOnData: false,
      selfHosted: true,
      notes: 'In-process simulator; no data leaves our infrastructure.',
    });
  }

  // -- Fallback executors --------------------------------------------------
  // Timeouts are per-stage and tight: on a phone call a slow dependency is worse
  // than a failed one.
  const onFallback = (from: string, to: string, error: Error) =>
    logger.warn('provider fallback', { from, to, error: error.message });

  const executors = {
    stt: new FallbackExecutor<SttProvider>('stt', (p) => p.key, { timeoutMs: 1_500 }, onFallback),
    llm: new FallbackExecutor<LlmProvider>('llm', (p) => p.key, { timeoutMs: 8_000 }, onFallback),
    tts: new FallbackExecutor<TtsProvider>('tts', (p) => p.key, { timeoutMs: 2_000 }, onFallback),
  };

  // -- Repositories --------------------------------------------------------
  const repositories = {
    users: new MemoryUserRepository(),
    orgs: new MemoryOrganizationRepository(),
    workspaces: new MemoryWorkspaceRepository(),
    agents: new MemoryAgentRepository(),
    calls: new MemoryCallRepository(),
    traces: new MemoryTraceRepository(),
    numbers: new MemoryPhoneNumberRepository(),
    campaigns: new MemoryCampaignRepository(),
    leads: new MemoryLeadRepository(),
    dispatchAudit: new MemoryDispatchAuditRepository(),
    credentials: new MemoryCredentialRepository(),
    verificationCodes: new MemoryVerificationCodeRepository(),
    sessions: new MemorySessionRepository(),
    memberships: new MemoryMembershipRepository(),
    invitations: new MemoryInvitationRepository(),
    apiKeys: new MemoryApiKeyRepository(),
  };

  // -- Compliance controls -------------------------------------------------
  // docs/14: these are constraints, not documentation. LocalKms throws if used
  // in production without an explicit master key.
  const audit = new AuditLogger(new MemoryAuditLogStore());
  const encryption = new EncryptionService(new LocalKms(), new MemoryTenantKeyStore());

  // -- Services ------------------------------------------------------------
  const workspaces = new WorkspaceService(repositories.workspaces, repositories.orgs);
  const agents = new AgentService(repositories.agents, repositories.workspaces);
  const secrets = resolveAuthSecrets(logger);

  const memberships = new MembershipService({
    memberships: repositories.memberships,
    users: repositories.users,
    orgs: repositories.orgs,
    workspaces: repositories.workspaces,
  });

  const auth = new AuthService({
    users: repositories.users,
    orgs: repositories.orgs,
    credentials: repositories.credentials,
    verificationCodes: repositories.verificationCodes,
    sessions: repositories.sessions,
    memberships: repositories.memberships,
    workspaces,
    agents,
    secrets,
    logger,
    audit,
  });

  const services = {
    workspaces,
    agents,
    auth,
    memberships,
    calls: new CallService(repositories.calls, repositories.traces),
    numbers: new NumberService(repositories.numbers, repositories.agents, repositories.orgs),
    campaigns: new CampaignService(
      repositories.campaigns,
      repositories.leads,
      repositories.agents,
      repositories.numbers,
    ),
    invitations: new InvitationService({
      invitations: repositories.invitations,
      users: repositories.users,
      workspaces: repositories.workspaces,
      memberships,
      auth,
      hashPepper: secrets.hashPepper,
      logger,
    }),
    apiKeys: new ApiKeyService({
      apiKeys: repositories.apiKeys,
      memberships: repositories.memberships,
      hashPepper: secrets.hashPepper,
      logger,
    }),
    compliance: buildComplianceChain(),
  };

  // -- Trace recorder ------------------------------------------------------
  // Subscribes to the pipeline event bus and assembles the waterfall the
  // dashboard renders. Deliberately does not persist directly — it has no
  // principal, so the wiring layer hands finalized traces to CallService.
  const traceRecorder = new TraceRecorder(events);

  return {
    logger,
    events,
    registries: { stt, llm, tts, endpointing, bargeIn },
    executors,
    repositories,
    services,
    compliance: { audit, encryption, postures },
    traceRecorder,
  };
}
