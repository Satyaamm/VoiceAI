/**
 * Repository interfaces for the identity/auth surface.
 *
 * Most repositories in this codebase take a `TenantScope` first, because a read
 * without a scope is a cross-tenant leak waiting to happen (docs/10 §Scoping).
 * Authentication is the one place where that cannot hold: you have to find the
 * credential, session, or API key BEFORE you know which tenant the caller is in.
 *
 * Those methods are therefore named explicitly and grouped under a
 * "pre-authorization" comment in each interface. Everything reachable after a
 * Principal exists goes back to being scope-first. If a method is not in a
 * pre-authorization block and does not take a scope, that is a bug.
 */

import type { Mode, OrgRole, WorkspaceRole } from '../domain/schemas.js';
import type { TenantScope, WorkspaceScope } from '../domain/tenant.js';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Password material. Kept in its own table/row from the User on purpose: a user
 * record is read on almost every request, and a credential is read on exactly
 * one. Never widen this type into anything that gets serialised.
 */
export interface CredentialRecord {
  userId: string;
  /** Only 'scrypt' today. Present so a future rehash can be staged per-user. */
  algorithm: 'scrypt';
  /** Hex. Per-user, random, 16 bytes. */
  salt: string;
  /** Hex. scrypt(password, salt, params). */
  hash: string;
  params: { N: number; r: number; p: number; keylen: number };
  updatedAt: string;
}

export interface VerificationCodeRecord {
  id: string;
  userId: string;
  email: string;
  /** HMAC of the 6-digit code. The code itself is never stored. */
  codeHash: string;
  purpose: 'email_verification';
  attempts: number;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  /** The org this session is anchored to. Org switching mints a new session. */
  orgId: string;
  userAgent?: string;
  ip?: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface WorkspaceGrant {
  workspaceId: string;
  role: WorkspaceRole;
}

export interface OrgMembershipRecord {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  /** Explicit grants only. Owners/admins get implicit workspace_admin in tenant.ts. */
  workspaceRoles: WorkspaceGrant[];
  joinedAt: string;
  lastActiveAt?: string;
}

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface InvitationRecord {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  workspaceGrants: WorkspaceGrant[];
  invitedByUserId: string;
  status: InvitationStatus;
  /** HMAC of the invite token. The token is shown once, in the invite email. */
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt?: string;
  acceptedByUserId?: string;
  revokedAt?: string;
}

export interface ApiKeyRecord {
  id: string;
  orgId: string;
  /** API keys are workspace-scoped, never org-scoped (docs/10 §Scoping rule 4). */
  workspaceId: string;
  name: string;
  /** Displayable, non-secret: `key_live_a1b2c3`. */
  prefix: string;
  /** HMAC of the full secret. The secret is returned exactly once, at creation. */
  secretHash: string;
  mode: Mode;
  createdByUserId: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CredentialRepository {
  // -- pre-authorization ---------------------------------------------------
  findByUserId(userId: string): Promise<CredentialRecord | null>;
  upsert(record: CredentialRecord): Promise<CredentialRecord>;
  delete(userId: string): Promise<void>;
}

export interface VerificationCodeRepository {
  // -- pre-authorization ---------------------------------------------------
  create(record: VerificationCodeRecord): Promise<VerificationCodeRecord>;
  /** Most recent unconsumed code for a user, expired or not — expiry is a service rule. */
  findLatestForUser(userId: string, purpose: 'email_verification'): Promise<VerificationCodeRecord | null>;
  update(id: string, patch: Partial<VerificationCodeRecord>): Promise<VerificationCodeRecord>;
  /** Invalidate outstanding codes when a new one is issued. */
  consumeAllForUser(userId: string, purpose: 'email_verification'): Promise<void>;
}

export interface SessionRepository {
  // -- pre-authorization ---------------------------------------------------
  findById(id: string): Promise<SessionRecord | null>;
  create(record: SessionRecord): Promise<SessionRecord>;
  update(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord>;
  revoke(id: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

export interface MembershipRepository {
  // -- pre-authorization: this is how a Principal is built ------------------
  listForUser(userId: string): Promise<OrgMembershipRecord[]>;
  findForUserInOrg(userId: string, orgId: string): Promise<OrgMembershipRecord | null>;
  /** Last-owner invariant. Unscoped because it is also checked during provisioning. */
  countByRole(orgId: string, role: OrgRole): Promise<number>;
  create(record: OrgMembershipRecord): Promise<OrgMembershipRecord>;

  // -- scoped --------------------------------------------------------------
  list(scope: TenantScope): Promise<OrgMembershipRecord[]>;
  get(scope: TenantScope, membershipId: string): Promise<OrgMembershipRecord | null>;
  update(
    scope: TenantScope,
    membershipId: string,
    patch: Partial<OrgMembershipRecord>,
  ): Promise<OrgMembershipRecord>;
  delete(scope: TenantScope, membershipId: string): Promise<void>;
}

export interface InvitationRepository {
  // -- pre-authorization: an invitee has no membership yet, by definition ---
  findByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;
  findPendingByEmail(email: string): Promise<InvitationRecord[]>;
  /** Accept/expire happen without a scope: the actor is not yet a member. */
  updateUnscoped(id: string, patch: Partial<InvitationRecord>): Promise<InvitationRecord>;

  // -- scoped --------------------------------------------------------------
  create(scope: TenantScope, record: InvitationRecord): Promise<InvitationRecord>;
  list(scope: TenantScope): Promise<InvitationRecord[]>;
  get(scope: TenantScope, invitationId: string): Promise<InvitationRecord | null>;
  update(
    scope: TenantScope,
    invitationId: string,
    patch: Partial<InvitationRecord>,
  ): Promise<InvitationRecord>;
}

export interface ApiKeyRepository {
  // -- pre-authorization: a key IS the credential --------------------------
  /**
   * Prefix is indexed and non-secret; it narrows the candidate set so the
   * constant-time hash comparison runs over a bounded number of rows.
   */
  findByPrefix(prefix: string): Promise<ApiKeyRecord[]>;
  touch(id: string, at: string): Promise<void>;

  // -- scoped --------------------------------------------------------------
  create(scope: WorkspaceScope, record: ApiKeyRecord): Promise<ApiKeyRecord>;
  list(scope: WorkspaceScope): Promise<ApiKeyRecord[]>;
  get(scope: WorkspaceScope, apiKeyId: string): Promise<ApiKeyRecord | null>;
  update(
    scope: WorkspaceScope,
    apiKeyId: string,
    patch: Partial<ApiKeyRecord>,
  ): Promise<ApiKeyRecord>;
}
