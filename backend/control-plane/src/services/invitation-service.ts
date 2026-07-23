/**
 * Invitations.
 *
 * An invitation is a bearer credential delivered to an email address, so it is
 * treated like one: the token is high-entropy, stored only as an HMAC, shown
 * exactly once, expiring, single-use, and revocable.
 *
 * The interesting case is inviting someone with **no account yet**. They should
 * not have to sign up (which would auto-provision them a personal org, docs/11
 * §A) and then join a second org. Accepting an invite therefore provisions the
 * account directly into the inviting org — one step, no duplicate tenant.
 */

import { randomBytes } from 'node:crypto';

import { newId } from '../domain/ids.js';
import type { OrgRole, User } from '../domain/schemas.js';
import { require_, type TenantScope } from '../domain/tenant.js';
import type {
  InvitationRecord,
  InvitationRepository,
  WorkspaceGrant,
} from '../repositories/auth-repository.js';
import {
  ConflictError,
  NotFoundError,
  type UserRepository,
  type WorkspaceRepository,
} from '../repositories/types.js';
import type { Logger } from '../core/patterns/factory.js';
import {
  AuthenticationError,
  hmacHex,
  type AuthService,
  type IssuedSession,
} from './auth-service.js';
import type { MembershipService } from './membership-service.js';

const MAX_TOKEN_TTL_DAYS = 30;

export interface InvitationServiceDeps {
  invitations: InvitationRepository;
  users: UserRepository;
  workspaces: WorkspaceRepository;
  memberships: MembershipService;
  auth: AuthService;
  /** Peppers the token hash. Same value as the rest of the auth surface. */
  hashPepper: string;
  logger: Logger;
  mailer?: {
    sendInvitation(to: string, token: string, orgName: string): Promise<void>;
  };
}

export interface CreateInvitationInput {
  email: string;
  role: OrgRole;
  workspaceGrants: WorkspaceGrant[];
  expiresInDays: number;
}

export interface CreatedInvitation {
  invitation: InvitationRecord;
  /** Returned exactly once, at creation, for the invite link. Never stored. */
  token: string;
}

export interface AcceptInvitationResult {
  invitation: InvitationRecord;
  user: User;
  orgId: string;
  session: IssuedSession;
  /** True when the invite provisioned a brand-new account. */
  accountCreated: boolean;
}

export class InvitationService {
  constructor(private readonly deps: InvitationServiceDeps) {}

  // -- Create --------------------------------------------------------------

  async create(scope: TenantScope, input: CreateInvitationInput): Promise<CreatedInvitation> {
    require_(scope, 'org:members');

    // Only an owner can invite another owner. `org:billing` is owner-only in the
    // role table, so it is a sound proxy without re-deriving roles here.
    if (input.role === 'owner' && !scope.permissions.has('org:billing')) {
      throw new ConflictError('only an owner can invite another owner');
    }

    const email = input.email.toLowerCase();

    // Already a member? Say so, rather than sending a dead invite.
    const existingUser = await this.deps.users.findByEmail(email);
    if (existingUser) {
      const membership = await this.deps.memberships.findForUserInOrg(existingUser.id, scope.orgId);
      if (membership) throw new ConflictError('this person is already a member of the organization');
    }

    // Workspace grants are validated through the SCOPED repository, so an invite
    // can never carry a grant into another org's workspace.
    for (const grant of input.workspaceGrants) {
      const ws = await this.deps.workspaces.get(scope, grant.workspaceId);
      if (!ws) throw new NotFoundError('workspace', grant.workspaceId);
    }

    // Re-inviting supersedes: the old token stops working immediately.
    for (const pending of await this.deps.invitations.findPendingByEmail(email)) {
      if (pending.orgId === scope.orgId) {
        await this.deps.invitations.updateUnscoped(pending.id, {
          status: 'revoked',
          revokedAt: new Date().toISOString(),
        });
      }
    }

    const token = randomBytes(32).toString('base64url');
    const days = Math.min(input.expiresInDays, MAX_TOKEN_TTL_DAYS);
    const record: InvitationRecord = {
      id: newId('invitation'),
      orgId: scope.orgId,
      email,
      role: input.role,
      workspaceGrants: input.workspaceGrants,
      invitedByUserId: scope.userId,
      status: 'pending',
      tokenHash: hmacHex(this.deps.hashPepper, token),
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    const invitation = await this.deps.invitations.create(scope, record);
    if (this.deps.mailer) {
      await this.deps.mailer.sendInvitation(email, token, scope.orgId);
    }
    this.deps.logger.info('invitation created', {
      invitationId: invitation.id,
      orgId: scope.orgId,
      role: invitation.role,
    });

    return { invitation, token };
  }

  // -- Read ----------------------------------------------------------------

  async list(scope: TenantScope): Promise<InvitationRecord[]> {
    require_(scope, 'org:read');
    const rows = await this.deps.invitations.list(scope);
    // Lazily reconcile status on read — no scheduler required for correctness.
    return Promise.all(rows.map((r) => this.reconcileExpiry(r)));
  }

  /**
   * Public preview for the accept screen: the invitee is not authenticated yet,
   * so this deliberately returns the minimum — never the inviter's details, the
   * member list, or anything else about the org.
   */
  async preview(token: string): Promise<{
    orgId: string;
    email: string;
    role: OrgRole;
    expiresAt: string;
    accountExists: boolean;
  }> {
    const invitation = await this.requirePending(token);
    const user = await this.deps.users.findByEmail(invitation.email);
    return {
      orgId: invitation.orgId,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      accountExists: Boolean(user),
    };
  }

  // -- Accept --------------------------------------------------------------

  /**
   * Accepting is single-use and atomic-ish: membership first, then the record is
   * marked accepted. If the membership write fails the invite stays pending,
   * which is the safe direction to fail.
   *
   * `actorUserId` is the authenticated caller, if any. When the invited email
   * already has an account, we require that the caller IS that account — token
   * possession alone must not hand out a session for an existing password-
   * protected user.
   */
  async accept(
    token: string,
    input: {
      password?: string;
      firstName?: string;
      familyName?: string;
      timezone?: string;
      locale?: string;
    } = {},
    ctx: { actorUserId?: string; userAgent?: string; ip?: string } = {},
  ): Promise<AcceptInvitationResult> {
    const invitation = await this.requirePending(token);

    let user = await this.deps.users.findByEmail(invitation.email);
    let accountCreated = false;

    if (user) {
      if (ctx.actorUserId !== user.id) {
        throw new AuthenticationError(
          'sign in as ' + invitation.email + ' to accept this invitation',
          'session_invalid',
          401,
        );
      }
    } else {
      if (!input.password) {
        throw new AuthenticationError(
          'a password is required to create an account from this invitation',
          'invalid_credentials',
          400,
        );
      }
      // The invite was delivered to this address, so control of it is proven.
      user = await this.deps.auth.registerUser({
        email: invitation.email,
        password: input.password,
        firstName: input.firstName,
        familyName: input.familyName,
        timezone: input.timezone,
        locale: input.locale,
        emailVerified: true,
      });
      accountCreated = true;
    }

    await this.deps.memberships.addMemberUnscoped(invitation.orgId, {
      userId: user.id,
      role: invitation.role,
      workspaceGrants: invitation.workspaceGrants,
    });

    const accepted = await this.deps.invitations.updateUnscoped(invitation.id, {
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
      acceptedByUserId: user.id,
    });

    const session = await this.deps.auth.issueSession(user.id, invitation.orgId, {
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });

    this.deps.logger.info('invitation accepted', {
      invitationId: accepted.id,
      orgId: accepted.orgId,
      accountCreated,
    });

    return { invitation: accepted, user, orgId: invitation.orgId, session, accountCreated };
  }

  // -- Revoke / expire -----------------------------------------------------

  async revoke(scope: TenantScope, invitationId: string): Promise<InvitationRecord> {
    require_(scope, 'org:members');
    const invitation = await this.deps.invitations.get(scope, invitationId);
    if (!invitation) throw new NotFoundError('invitation', invitationId);
    if (invitation.status === 'accepted') {
      throw new ConflictError('invitation already accepted — remove the member instead');
    }
    return this.deps.invitations.update(scope, invitationId, {
      status: 'revoked',
      revokedAt: new Date().toISOString(),
    });
  }

  /** Idempotent sweep. Correctness does not depend on it — `list`/`accept` also check. */
  async expireStale(scope: TenantScope): Promise<number> {
    require_(scope, 'org:members');
    const rows = await this.deps.invitations.list(scope);
    let expired = 0;
    for (const row of rows) {
      if (row.status === 'pending' && Date.parse(row.expiresAt) <= Date.now()) {
        await this.deps.invitations.update(scope, row.id, { status: 'expired' });
        expired += 1;
      }
    }
    return expired;
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Resolves a raw token to a *pending, unexpired* invitation. Every failure
   * mode returns the same opaque error: a distinguishable "expired" vs "unknown"
   * response turns this into a token-probing oracle.
   */
  private async requirePending(token: string): Promise<InvitationRecord> {
    const tokenHash = hmacHex(this.deps.hashPepper, token);
    const invitation = await this.deps.invitations.findByTokenHash(tokenHash);
    const opaque = new AuthenticationError(
      'this invitation is no longer valid',
      'session_invalid',
      404,
    );
    if (!invitation) throw opaque;

    const reconciled = await this.reconcileExpiry(invitation);
    if (reconciled.status !== 'pending') throw opaque;
    return reconciled;
  }

  private async reconcileExpiry(row: InvitationRecord): Promise<InvitationRecord> {
    if (row.status !== 'pending' || Date.parse(row.expiresAt) > Date.now()) return row;
    return this.deps.invitations.updateUnscoped(row.id, { status: 'expired' });
  }
}
