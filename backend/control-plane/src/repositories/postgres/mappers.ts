/**
 * Row <-> domain mapping.
 *
 * Two translations happen here and nowhere else:
 *
 *   * `timestamptz` arrives as a JS `Date`; the domain (and the wire contract) uses
 *     an ISO-8601 string. `Date.toISOString()` always emits UTC with a `Z`, which is
 *     exactly what `z.string().datetime()` accepts.
 *   * SQL nullable columns arrive as `null`; the Zod schemas model those same fields
 *     as `.optional()`, i.e. `undefined`. `null` is not `undefined` and `z.optional()`
 *     rejects it, so the boundary has to normalise. See README §Zod vs SQL.
 */

import type { Agent, Organization, User, Workspace } from '../../domain/schemas.js';
import type {
  AgentRow,
  NewAgentRow,
  NewOrganizationRow,
  NewUserRow,
  NewWorkspaceRow,
  OrganizationRow,
  UserRow,
  WorkspaceRow,
} from '../../db/schema.js';

/** SQL NULL -> TypeScript undefined. */
export function nn<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/** TypeScript undefined -> SQL NULL. */
export function nu<T>(value: T | undefined | null): T | null {
  return value ?? null;
}

export function iso(d: Date): string {
  return d.toISOString();
}

/** Parses an ISO string back to a Date for insert. Throws on garbage rather than storing it. */
export function toDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`invalid timestamp: ${value}`);
  return d;
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerified,
    firstName: row.firstName,
    familyName: row.familyName,
    jobTitle: nn(row.jobTitle),
    phone: nn(row.phone),
    avatarUrl: nn(row.avatarUrl),
    timezone: row.timezone,
    locale: row.locale,
    createdAt: iso(row.createdAt),
  };
}

export function userToRow(user: User): NewUserRow {
  return {
    id: user.id,
    // Stored lowercase; `users_email_lower_uq` is the guarantee, this is the habit.
    email: user.email.toLowerCase(),
    emailVerified: user.emailVerified,
    firstName: user.firstName,
    familyName: user.familyName,
    jobTitle: nu(user.jobTitle),
    phone: nu(user.phone),
    avatarUrl: nu(user.avatarUrl),
    timezone: user.timezone,
    locale: user.locale,
    createdAt: toDate(user.createdAt),
  };
}

export function userPatchToRow(patch: Partial<User>): Partial<NewUserRow> {
  const row: Partial<NewUserRow> = {};
  if (patch.email !== undefined) row.email = patch.email.toLowerCase();
  if (patch.emailVerified !== undefined) row.emailVerified = patch.emailVerified;
  if (patch.firstName !== undefined) row.firstName = patch.firstName;
  if (patch.familyName !== undefined) row.familyName = patch.familyName;
  if ('jobTitle' in patch) row.jobTitle = nu(patch.jobTitle);
  if ('phone' in patch) row.phone = nu(patch.phone);
  if ('avatarUrl' in patch) row.avatarUrl = nu(patch.avatarUrl);
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.locale !== undefined) row.locale = patch.locale;
  return row;
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export function rowToOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    parentOrgId: row.parentOrgId,
    name: row.name,
    legalName: nn(row.legalName),
    slug: row.slug,
    website: nn(row.website),
    industry: nn(row.industry),
    size: nn(row.size) as Organization['size'],
    country: row.country,
    address: nn(row.address),
    phone: nn(row.phone),
    taxId: nn(row.taxId),
    billingEmail: nn(row.billingEmail),
    timezone: row.timezone,
    currency: row.currency,
    logoUrl: nn(row.logoUrl),
    verifiedDomains: row.verifiedDomains,
    createdAt: iso(row.createdAt),
  };
}

export function organizationToRow(org: Organization): NewOrganizationRow {
  return {
    id: org.id,
    parentOrgId: nu(org.parentOrgId),
    name: org.name,
    legalName: nu(org.legalName),
    slug: org.slug,
    website: nu(org.website),
    industry: nu(org.industry),
    size: nu(org.size),
    country: org.country,
    address: nu(org.address),
    phone: nu(org.phone),
    taxId: nu(org.taxId),
    billingEmail: nu(org.billingEmail),
    timezone: org.timezone,
    currency: org.currency,
    logoUrl: nu(org.logoUrl),
    verifiedDomains: org.verifiedDomains,
    createdAt: toDate(org.createdAt),
  };
}

export function organizationPatchToRow(
  patch: Partial<Organization>,
): Partial<NewOrganizationRow> {
  const row: Partial<NewOrganizationRow> = {};
  if ('parentOrgId' in patch) row.parentOrgId = nu(patch.parentOrgId);
  if (patch.name !== undefined) row.name = patch.name;
  if ('legalName' in patch) row.legalName = nu(patch.legalName);
  if (patch.slug !== undefined) row.slug = patch.slug;
  if ('website' in patch) row.website = nu(patch.website);
  if ('industry' in patch) row.industry = nu(patch.industry);
  if ('size' in patch) row.size = nu(patch.size);
  if (patch.country !== undefined) row.country = patch.country;
  if ('address' in patch) row.address = nu(patch.address);
  if ('phone' in patch) row.phone = nu(patch.phone);
  if ('taxId' in patch) row.taxId = nu(patch.taxId);
  if ('billingEmail' in patch) row.billingEmail = nu(patch.billingEmail);
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.currency !== undefined) row.currency = patch.currency;
  if ('logoUrl' in patch) row.logoUrl = nu(patch.logoUrl);
  if (patch.verifiedDomains !== undefined) row.verifiedDomains = patch.verifiedDomains;
  return row;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * `spend` and `stats` are deliberately absent: they are computed roll-ups served by
 * the analytics path, not columns. The memory repository does not populate them
 * either, so the two implementations agree.
 */
export function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    slug: row.slug,
    description: nn(row.description),
    region: row.region,
    regionLocked: row.regionLocked,
    compliance: row.compliance,
    spendCaps: row.spendCaps,
    createdAt: iso(row.createdAt),
  };
}

export function workspaceToRow(ws: Workspace, orgId: string): NewWorkspaceRow {
  return {
    id: ws.id,
    orgId,
    name: ws.name,
    slug: ws.slug,
    description: nu(ws.description),
    region: ws.region,
    regionLocked: ws.regionLocked,
    compliance: ws.compliance,
    spendCaps: ws.spendCaps,
    createdAt: toDate(ws.createdAt),
  };
}

export function workspacePatchToRow(patch: Partial<Workspace>): Partial<NewWorkspaceRow> {
  const row: Partial<NewWorkspaceRow> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.slug !== undefined) row.slug = patch.slug;
  if ('description' in patch) row.description = nu(patch.description);
  if (patch.region !== undefined) row.region = patch.region;
  if (patch.regionLocked !== undefined) row.regionLocked = patch.regionLocked;
  if (patch.compliance !== undefined) row.compliance = patch.compliance;
  if (patch.spendCaps !== undefined) row.spendCaps = patch.spendCaps;
  return row;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    version: row.version,
    description: row.description,
    language: row.language,
    prompt: row.prompt,
    voice: row.voice,
    pipeline: row.pipeline,
    tools: row.tools,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    stats: row.stats,
  };
}

export function agentToRow(agent: Agent, orgId: string, workspaceId: string): NewAgentRow {
  return {
    id: agent.id,
    orgId,
    workspaceId,
    name: agent.name,
    status: agent.status,
    version: agent.version,
    description: agent.description,
    language: agent.language,
    prompt: agent.prompt,
    voice: agent.voice,
    pipeline: agent.pipeline,
    tools: agent.tools,
    stats: agent.stats,
    createdAt: toDate(agent.createdAt),
    updatedAt: toDate(agent.updatedAt),
  };
}

export function agentPatchToRow(patch: Partial<Agent>): Partial<NewAgentRow> {
  const row: Partial<NewAgentRow> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.version !== undefined) row.version = patch.version;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.language !== undefined) row.language = patch.language;
  if (patch.prompt !== undefined) row.prompt = patch.prompt;
  if (patch.voice !== undefined) row.voice = patch.voice;
  if (patch.pipeline !== undefined) row.pipeline = patch.pipeline;
  if (patch.tools !== undefined) row.tools = patch.tools;
  if (patch.stats !== undefined) row.stats = patch.stats;
  return row;
}

// ---------------------------------------------------------------------------
// Shared query helpers
// ---------------------------------------------------------------------------

/** Escapes LIKE/ILIKE metacharacters so a search for "50%" means "50%". */
export function likeTerm(search: string): string {
  return `%${search.replace(/([\\%_])/g, '\\$1')}%`;
}

/** Postgres unique-violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
