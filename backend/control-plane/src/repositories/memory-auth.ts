/**
 * In-memory auth repositories.
 *
 * Same contract as `memory.ts`: Phase 1 storage so the whole signup -> session ->
 * API key path can be exercised end-to-end before Postgres exists. The Postgres
 * implementations satisfy the same interfaces, so swapping is a container change.
 *
 * Note that every scoped read filters on `scope.orgId` (and `scope.workspaceId`
 * for API keys) before returning a row, exactly like the workspace/agent repos.
 */

import type {
  ApiKeyRecord,
  ApiKeyRepository,
  CredentialRecord,
  CredentialRepository,
  InvitationRecord,
  InvitationRepository,
  MembershipRepository,
  OrgMembershipRecord,
  SessionRecord,
  SessionRepository,
  VerificationCodeRecord,
  VerificationCodeRepository,
} from './auth-repository.js';
import { ConflictError, NotFoundError } from './types.js';
import type { OrgRole } from '../domain/schemas.js';
import type { TenantScope, WorkspaceScope } from '../domain/tenant.js';

export class MemoryCredentialRepository implements CredentialRepository {
  constructor(private readonly rows = new Map<string, CredentialRecord>()) {}

  async findByUserId(userId: string) {
    return this.rows.get(userId) ?? null;
  }
  async upsert(record: CredentialRecord) {
    this.rows.set(record.userId, record);
    return record;
  }
  async delete(userId: string) {
    this.rows.delete(userId);
  }
}

export class MemoryVerificationCodeRepository implements VerificationCodeRepository {
  constructor(private readonly rows = new Map<string, VerificationCodeRecord>()) {}

  async create(record: VerificationCodeRecord) {
    this.rows.set(record.id, record);
    return record;
  }

  async findLatestForUser(userId: string, purpose: 'email_verification') {
    return (
      [...this.rows.values()]
        .filter((r) => r.userId === userId && r.purpose === purpose && !r.consumedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    );
  }

  async update(id: string, patch: Partial<VerificationCodeRecord>) {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError('verification code', id);
    const next = { ...existing, ...patch, id: existing.id };
    this.rows.set(id, next);
    return next;
  }

  async consumeAllForUser(userId: string, purpose: 'email_verification') {
    const now = new Date().toISOString();
    for (const [id, row] of this.rows) {
      if (row.userId === userId && row.purpose === purpose && !row.consumedAt) {
        this.rows.set(id, { ...row, consumedAt: now });
      }
    }
  }
}

export class MemorySessionRepository implements SessionRepository {
  constructor(private readonly rows = new Map<string, SessionRecord>()) {}

  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async create(record: SessionRecord) {
    this.rows.set(record.id, record);
    return record;
  }
  async update(id: string, patch: Partial<SessionRecord>) {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError('session', id);
    const next = { ...existing, ...patch, id: existing.id };
    this.rows.set(id, next);
    return next;
  }
  async revoke(id: string) {
    const existing = this.rows.get(id);
    if (!existing) return; // idempotent: logging out twice is not an error
    this.rows.set(id, { ...existing, revokedAt: new Date().toISOString() });
  }
  async revokeAllForUser(userId: string) {
    const now = new Date().toISOString();
    for (const [id, row] of this.rows) {
      if (row.userId === userId && !row.revokedAt) this.rows.set(id, { ...row, revokedAt: now });
    }
  }
}

export class MemoryMembershipRepository implements MembershipRepository {
  constructor(private readonly rows = new Map<string, OrgMembershipRecord>()) {}

  private all(): OrgMembershipRecord[] {
    return [...this.rows.values()];
  }

  async listForUser(userId: string) {
    return this.all().filter((m) => m.userId === userId);
  }

  async findForUserInOrg(userId: string, orgId: string) {
    return this.all().find((m) => m.userId === userId && m.orgId === orgId) ?? null;
  }

  async countByRole(orgId: string, role: OrgRole) {
    return this.all().filter((m) => m.orgId === orgId && m.role === role).length;
  }

  async create(record: OrgMembershipRecord) {
    if (await this.findForUserInOrg(record.userId, record.orgId)) {
      throw new ConflictError(`user is already a member of ${record.orgId}`);
    }
    this.rows.set(record.id, record);
    return record;
  }

  async list(scope: TenantScope) {
    return this.all()
      .filter((m) => m.orgId === scope.orgId)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  async get(scope: TenantScope, membershipId: string) {
    const row = this.rows.get(membershipId);
    return row && row.orgId === scope.orgId ? row : null;
  }

  async update(scope: TenantScope, membershipId: string, patch: Partial<OrgMembershipRecord>) {
    const existing = await this.get(scope, membershipId);
    if (!existing) throw new NotFoundError('membership', membershipId);
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      orgId: existing.orgId,
      userId: existing.userId,
    };
    this.rows.set(next.id, next);
    return next;
  }

  async delete(scope: TenantScope, membershipId: string) {
    const existing = await this.get(scope, membershipId);
    if (!existing) throw new NotFoundError('membership', membershipId);
    this.rows.delete(membershipId);
  }
}

export class MemoryInvitationRepository implements InvitationRepository {
  constructor(private readonly rows = new Map<string, InvitationRecord>()) {}

  async findByTokenHash(tokenHash: string) {
    return [...this.rows.values()].find((i) => i.tokenHash === tokenHash) ?? null;
  }

  async findPendingByEmail(email: string) {
    const needle = email.toLowerCase();
    return [...this.rows.values()].filter(
      (i) => i.email.toLowerCase() === needle && i.status === 'pending',
    );
  }

  async updateUnscoped(id: string, patch: Partial<InvitationRecord>) {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError('invitation', id);
    const next = { ...existing, ...patch, id: existing.id, orgId: existing.orgId };
    this.rows.set(id, next);
    return next;
  }

  async create(scope: TenantScope, record: InvitationRecord) {
    const row = { ...record, orgId: scope.orgId };
    this.rows.set(row.id, row);
    return row;
  }

  async list(scope: TenantScope) {
    return [...this.rows.values()]
      .filter((i) => i.orgId === scope.orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(scope: TenantScope, invitationId: string) {
    const row = this.rows.get(invitationId);
    return row && row.orgId === scope.orgId ? row : null;
  }

  async update(scope: TenantScope, invitationId: string, patch: Partial<InvitationRecord>) {
    const existing = await this.get(scope, invitationId);
    if (!existing) throw new NotFoundError('invitation', invitationId);
    return this.updateUnscoped(invitationId, patch);
  }
}

export class MemoryApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly rows = new Map<string, ApiKeyRecord>()) {}

  async findByPrefix(prefix: string) {
    return [...this.rows.values()].filter((k) => k.prefix === prefix);
  }

  async touch(id: string, at: string) {
    const existing = this.rows.get(id);
    if (!existing) return;
    this.rows.set(id, { ...existing, lastUsedAt: at });
  }

  async create(scope: WorkspaceScope, record: ApiKeyRecord) {
    const row = { ...record, orgId: scope.orgId, workspaceId: scope.workspaceId };
    this.rows.set(row.id, row);
    return row;
  }

  async list(scope: WorkspaceScope) {
    return [...this.rows.values()]
      .filter((k) => k.orgId === scope.orgId && k.workspaceId === scope.workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(scope: WorkspaceScope, apiKeyId: string) {
    const row = this.rows.get(apiKeyId);
    return row && row.orgId === scope.orgId && row.workspaceId === scope.workspaceId ? row : null;
  }

  async update(scope: WorkspaceScope, apiKeyId: string, patch: Partial<ApiKeyRecord>) {
    const existing = await this.get(scope, apiKeyId);
    if (!existing) throw new NotFoundError('api key', apiKeyId);
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      orgId: existing.orgId,
      workspaceId: existing.workspaceId,
      // The hash is set once, at creation, and is never patchable.
      secretHash: existing.secretHash,
    };
    this.rows.set(next.id, next);
    return next;
  }
}
