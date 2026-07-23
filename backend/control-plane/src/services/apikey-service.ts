/**
 * API keys — workspace-scoped, mode-tagged, hash-at-rest.
 *
 * Four rules, all of them load-bearing:
 *
 * 1. **Workspace-scoped, never org-scoped** (docs/10 §Scoping rule 4). A leaked
 *    key exposes one workspace's numbers and spend, not the company.
 * 2. **Mode is in the prefix** — `key_test_…` / `key_live_…`. A leaked key is
 *    instantly classifiable, and a test key structurally cannot dial a human.
 * 3. **Shown exactly once** (docs/11 §9). We store an HMAC; there is no code
 *    path that can recover the secret, including for support.
 * 4. **Verification is constant-time on the hash.** The non-secret prefix
 *    narrows the candidate rows; the comparison itself never short-circuits.
 */

import { newId, newApiKeySecret } from '../domain/ids.js';
import type { Mode } from '../domain/schemas.js';
import { require_, type Principal, type WorkspaceScope } from '../domain/tenant.js';
import type { ApiKeyRecord, ApiKeyRepository, MembershipRepository } from '../repositories/auth-repository.js';
import { ConflictError, NotFoundError } from '../repositories/types.js';
import type { Logger } from '../core/patterns/factory.js';
import { hmacHex, timingSafeEqualHex } from './auth-service.js';

/** What a list call returns. Note the absence of anything secret. */
export interface ApiKeyView {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  mode: Mode;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/**
 * A Principal derived from an API key, plus the key context a caller needs to
 * pin the request's mode and workspace. The extra field is additive — this is
 * still a `Principal` everywhere one is expected.
 */
export interface ApiKeyPrincipal extends Principal {
  readonly apiKey: {
    id: string;
    workspaceId: string;
    /** Authoritative. A key's mode is NOT negotiable via an `x-mode` header. */
    mode: Mode;
    prefix: string;
  };
}

export interface ApiKeyServiceDeps {
  apiKeys: ApiKeyRepository;
  /** Only for `verify()` — a key inherits nothing from its creator's org role. */
  memberships: MembershipRepository;
  hashPepper: string;
  logger: Logger;
}

export class ApiKeyService {
  constructor(private readonly deps: ApiKeyServiceDeps) {}

  // -- Create --------------------------------------------------------------

  /**
   * Returns the plaintext secret ONCE. The caller must surface it in a modal
   * with an explicit "I've saved it" acknowledgement — a toast gets lost.
   *
   * Mode defaults to the request's current mode, so a session in test mode
   * cannot mint a live key by simply omitting the field.
   */
  async create(
    scope: WorkspaceScope,
    input: { name: string; mode?: Mode; expiresInDays?: number },
  ): Promise<{ apiKey: ApiKeyView; secret: string }> {
    require_(scope, 'apikey:manage');

    const mode: Mode = input.mode ?? scope.mode;
    if (mode === 'live' && scope.mode !== 'live') {
      throw new ConflictError(
        'switch to live mode to create a live key — minting live credentials from a test session is not allowed',
      );
    }

    const { secret, prefix } = newApiKeySecret(mode);
    const record: ApiKeyRecord = {
      id: newId('apiKey'),
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      name: input.name,
      prefix,
      secretHash: hmacHex(this.deps.hashPepper, secret),
      mode,
      createdByUserId: scope.userId,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1_000).toISOString()
        : undefined,
    };

    const created = await this.deps.apiKeys.create(scope, record);
    // Log the prefix, never the secret. The prefix is what appears in the UI.
    this.deps.logger.info('api key created', {
      apiKeyId: created.id,
      workspaceId: created.workspaceId,
      mode: created.mode,
      prefix: created.prefix,
    });
    return { apiKey: toView(created), secret };
  }

  // -- Read ----------------------------------------------------------------

  /** Prefix only. There is no variant of this method that returns the secret. */
  async list(scope: WorkspaceScope): Promise<ApiKeyView[]> {
    require_(scope, 'apikey:manage');
    const rows = await this.deps.apiKeys.list(scope);
    return rows.map(toView);
  }

  async get(scope: WorkspaceScope, apiKeyId: string): Promise<ApiKeyView> {
    require_(scope, 'apikey:manage');
    const row = await this.deps.apiKeys.get(scope, apiKeyId);
    if (!row) throw new NotFoundError('api key', apiKeyId);
    return toView(row);
  }

  // -- Revoke --------------------------------------------------------------

  /** Immediate and irreversible. Revoked keys are kept for the audit trail. */
  async revoke(scope: WorkspaceScope, apiKeyId: string): Promise<ApiKeyView> {
    require_(scope, 'apikey:manage');
    const row = await this.deps.apiKeys.get(scope, apiKeyId);
    if (!row) throw new NotFoundError('api key', apiKeyId);
    if (row.revokedAt) return toView(row);

    const updated = await this.deps.apiKeys.update(scope, apiKeyId, {
      revokedAt: new Date().toISOString(),
    });
    this.deps.logger.warn('api key revoked', { apiKeyId, workspaceId: row.workspaceId });
    return toView(updated);
  }

  // -- Verify --------------------------------------------------------------

  /**
   * Resolves a raw secret to a Principal, or null. Fails closed on every path:
   * malformed, unknown, revoked, expired, or a workspace whose org membership no
   * longer exists.
   *
   * The resulting Principal deliberately carries org role `member` — the weakest
   * role, granting only `org:read` — plus an explicit `workspace_admin` grant on
   * exactly the key's workspace. A key must not inherit its creator's ability to
   * change billing or delete the organization.
   */
  async verify(secret: string): Promise<ApiKeyPrincipal | null> {
    const parsed = parseSecret(secret);
    if (!parsed) return null;

    const candidates = await this.deps.apiKeys.findByPrefix(parsed.prefix);
    const presented = hmacHex(this.deps.hashPepper, secret);

    // Compare against every candidate without short-circuiting, so the work done
    // does not depend on which row (if any) matched.
    let matched: ApiKeyRecord | null = null;
    for (const candidate of candidates) {
      if (timingSafeEqualHex(presented, candidate.secretHash)) matched = candidate;
    }
    if (!matched) return null;

    if (matched.revokedAt) return null;
    if (matched.expiresAt && Date.parse(matched.expiresAt) <= Date.now()) return null;
    if (matched.mode !== parsed.mode) return null; // prefix and record must agree

    const membership = await this.deps.memberships.findForUserInOrg(
      matched.createdByUserId,
      matched.orgId,
    );
    // The creator left the org: the key dies with the membership.
    if (!membership) return null;

    await this.deps.apiKeys.touch(matched.id, new Date().toISOString());

    return {
      userId: matched.createdByUserId,
      orgId: matched.orgId,
      orgRole: 'member',
      workspaceRoles: new Map([[matched.workspaceId, 'workspace_admin' as const]]),
      apiKey: {
        id: matched.id,
        workspaceId: matched.workspaceId,
        mode: matched.mode,
        prefix: matched.prefix,
      },
    };
  }
}

// ---------------------------------------------------------------------------

/** `key_live_<32 chars>` -> `{ mode, prefix }`. Null on anything else. */
export function parseSecret(secret: string): { mode: Mode; prefix: string } | null {
  const match = /^key_(test|live)_([0-9a-z]{32})$/.exec(secret);
  if (!match) return null;
  const mode = match[1] as Mode;
  const body = match[2];
  if (!body) return null;
  return { mode, prefix: `key_${mode}_${body.slice(0, 6)}` };
}

function toView(row: ApiKeyRecord): ApiKeyView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    mode: row.mode,
    createdBy: row.createdByUserId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}
