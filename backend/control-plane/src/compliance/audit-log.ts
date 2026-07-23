/**
 * Append-only, hash-chained audit log.
 *
 * Required by SOC 2 CC7.2, HIPAA §164.312(b), and GDPR Art. 30. docs/14 §2.
 *
 * Three properties that are easy to get wrong and expensive to retrofit:
 *
 *  1. READS are audited, not just writes. HIPAA requires logging every access to
 *     PHI. That means `call:read_pii` accesses are individually recorded.
 *  2. The chain is tamper-EVIDENT. Each entry hashes the previous entry's hash, so
 *     deleting or editing history breaks verification. The application role must
 *     have INSERT only — no UPDATE, no DELETE (see db/rls.sql).
 *  3. Audit retention is INDEPENDENT of call retention. Calls may purge at 90 days;
 *     HIPAA wants audit records for 6 years.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { TenantScope } from '../domain/tenant.js';

export type AuditAction =
  // authentication
  | 'auth.login' | 'auth.login_failed' | 'auth.logout' | 'auth.signup'
  | 'auth.password_reset' | 'auth.email_verified'
  // access control
  | 'member.invited' | 'member.joined' | 'member.role_changed' | 'member.removed'
  | 'apikey.created' | 'apikey.revoked' | 'apikey.used'
  // configuration
  | 'workspace.created' | 'workspace.updated' | 'workspace.deleted'
  | 'agent.created' | 'agent.updated' | 'agent.published' | 'agent.rolled_back'
  | 'agent.deleted'
  | 'compliance.updated' | 'retention.updated' | 'region.locked'
  // data access — the HIPAA-critical ones
  | 'call.read' | 'call.pii_read' | 'recording.downloaded' | 'transcript.exported'
  // data subject rights
  | 'dsar.exported' | 'dsar.erased'
  // operations
  | 'call.dispatched' | 'call.blocked_by_compliance'
  | 'retention.purged';

export interface AuditEntry {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly orgId: string;
  readonly workspaceId: string | null;
  /** User id, API key id, or 'system'. */
  readonly actorId: string;
  readonly actorType: 'user' | 'api_key' | 'system';
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId: string | null;
  /** Never include PII here — this record outlives the data it describes. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly outcome: 'success' | 'failure';
  /** SHA-256 over this entry plus the previous entry's hash. */
  readonly hash: string;
  readonly previousHash: string;
}

export interface AuditLogStore {
  append(entry: AuditEntry): Promise<void>;
  /** Scoped read — the audit log is tenant data too. */
  list(
    orgId: string,
    opts?: {
      workspaceId?: string;
      actorId?: string;
      action?: AuditAction;
      from?: string;
      to?: string;
      limit?: number;
    },
  ): Promise<AuditEntry[]>;
  lastEntry(orgId: string): Promise<AuditEntry | null>;
}

const GENESIS = '0'.repeat(64);

function computeHash(
  entry: Omit<AuditEntry, 'hash'>,
): string {
  // Field order is fixed and explicit — a verifier in any language must be able to
  // reproduce this without knowing our object key ordering.
  const canonical = [
    entry.id,
    entry.sequence,
    entry.timestamp,
    entry.orgId,
    entry.workspaceId ?? '',
    entry.actorId,
    entry.actorType,
    entry.action,
    entry.resourceType,
    entry.resourceId ?? '',
    JSON.stringify(entry.metadata),
    entry.outcome,
    entry.previousHash,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

export class AuditLogger {
  /** Per-org sequence + last hash, so chains are independent per tenant. */
  private readonly heads = new Map<string, { sequence: number; hash: string }>();

  constructor(private readonly store: AuditLogStore) {}

  /**
   * Records an event. Deliberately NOT fire-and-forget for security-relevant
   * actions: if we cannot write the audit record, the action should not be
   * considered complete. Callers awaiting this is the point.
   */
  async record(
    scope: Pick<TenantScope, 'orgId' | 'workspaceId' | 'userId'>,
    action: AuditAction,
    opts: {
      resourceType: string;
      resourceId?: string | null;
      metadata?: Record<string, unknown>;
      outcome?: 'success' | 'failure';
      actorType?: 'user' | 'api_key' | 'system';
      context?: AuditContext;
    },
  ): Promise<AuditEntry> {
    const head = await this.head(scope.orgId);
    const base = {
      id: randomUUID(),
      sequence: head.sequence + 1,
      timestamp: new Date().toISOString(),
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      actorId: scope.userId,
      actorType: opts.actorType ?? ('user' as const),
      action,
      resourceType: opts.resourceType,
      resourceId: opts.resourceId ?? null,
      metadata: Object.freeze(scrub(opts.metadata ?? {})),
      ipAddress: opts.context?.ipAddress,
      userAgent: opts.context?.userAgent,
      outcome: opts.outcome ?? ('success' as const),
      previousHash: head.hash,
    };

    const entry: AuditEntry = { ...base, hash: computeHash(base) };
    await this.store.append(entry);
    this.heads.set(scope.orgId, { sequence: entry.sequence, hash: entry.hash });
    return entry;
  }

  /**
   * Convenience for the HIPAA-critical case: every read of PII is its own record.
   * docs/14 §3 — HIPAA §164.312(b) requires logging reads, which most teams miss.
   */
  async recordPiiAccess(
    scope: Pick<TenantScope, 'orgId' | 'workspaceId' | 'userId'>,
    resourceType: string,
    resourceId: string,
    context?: AuditContext,
  ): Promise<AuditEntry> {
    return this.record(scope, 'call.pii_read', {
      resourceType,
      resourceId,
      metadata: { reason: 'unmasked_read' },
      context,
    });
  }

  /**
   * Scoped read. The audit log is tenant data too — it is never queryable across
   * orgs, and the caller must already hold `org:members` (checked at the route).
   */
  async listFor(
    scope: Pick<TenantScope, 'orgId'>,
    opts: { workspaceId?: string; actorId?: string; action?: AuditAction; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    return this.store.list(scope.orgId, opts);
  }

  /**
   * Verifies chain integrity for an org. Auditors ask for this; so does any
   * incident investigation.
   */
  async verify(orgId: string): Promise<
    { valid: true; entries: number } | { valid: false; brokenAt: number; reason: string }
  > {
    const entries = await this.store.list(orgId, { limit: Number.MAX_SAFE_INTEGER });
    const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);

    let previousHash = GENESIS;
    for (const entry of ordered) {
      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          brokenAt: entry.sequence,
          reason: 'previousHash does not match the preceding entry — an entry was removed or reordered',
        };
      }
      const { hash, ...rest } = entry;
      if (computeHash(rest) !== hash) {
        return {
          valid: false,
          brokenAt: entry.sequence,
          reason: 'entry hash mismatch — the entry was modified after it was written',
        };
      }
      previousHash = hash;
    }
    return { valid: true, entries: ordered.length };
  }

  private async head(orgId: string): Promise<{ sequence: number; hash: string }> {
    const cached = this.heads.get(orgId);
    if (cached) return cached;
    const last = await this.store.lastEntry(orgId);
    const head = last
      ? { sequence: last.sequence, hash: last.hash }
      : { sequence: 0, hash: GENESIS };
    this.heads.set(orgId, head);
    return head;
  }
}

/**
 * Strips anything that looks like personal data from audit metadata.
 *
 * The audit log outlives the data it describes (HIPAA: 6 years vs. a 90-day call
 * retention), so putting a transcript or a phone number in here would quietly
 * defeat both erasure and retention limits.
 */
const SENSITIVE_KEYS =
  /^(transcript|prompt|content|text|recording|audio|phone|email|address|name|dob|ssn|card|token|secret|password)/i;

function scrub(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? scrub(value as Record<string, unknown>)
        : value;
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Phase 1 store. The Postgres version must grant INSERT only — never UPDATE/DELETE. */
export class MemoryAuditLogStore implements AuditLogStore {
  private readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async list(orgId: string, opts: Parameters<AuditLogStore['list']>[1] = {}) {
    let rows = this.entries.filter((e) => e.orgId === orgId);
    if (opts.workspaceId) rows = rows.filter((e) => e.workspaceId === opts.workspaceId);
    if (opts.actorId) rows = rows.filter((e) => e.actorId === opts.actorId);
    if (opts.action) rows = rows.filter((e) => e.action === opts.action);
    if (opts.from) rows = rows.filter((e) => e.timestamp >= opts.from!);
    if (opts.to) rows = rows.filter((e) => e.timestamp <= opts.to!);
    return rows
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, opts.limit ?? 100);
  }

  async lastEntry(orgId: string) {
    const rows = this.entries.filter((e) => e.orgId === orgId);
    return rows.length ? rows.reduce((a, b) => (a.sequence > b.sequence ? a : b)) : null;
  }
}
