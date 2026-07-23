/**
 * In-memory repositories.
 *
 * Phase 1 storage so the API and dashboard can be built end-to-end before Postgres
 * exists. The Postgres implementations satisfy the same interfaces, so swapping is
 * a one-line change in the container.
 *
 * Note how every read filters on `scope.orgId` — that's the behaviour the Postgres
 * version enforces again with row-level security.
 */

import type {
  AgentRepository,
  ListOptions,
  OrganizationRepository,
  Page,
  UserRepository,
  WorkspaceRepository,
} from './types.js';
import { ConflictError, NotFoundError } from './types.js';
import type { Agent, Organization, User, Workspace } from '../domain/schemas.js';
import type { TenantScope, WorkspaceScope } from '../domain/tenant.js';

function paginate<T>(items: T[], opts: ListOptions = {}): Page<T> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 25;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
}

function matches(search: string | undefined, ...fields: string[]): boolean {
  if (!search) return true;
  const q = search.toLowerCase();
  return fields.some((f) => f.toLowerCase().includes(q));
}

export class MemoryUserRepository implements UserRepository {
  constructor(private readonly users = new Map<string, User>()) {}

  async findById(id: string) {
    return this.users.get(id) ?? null;
  }
  async findByEmail(email: string) {
    const needle = email.toLowerCase();
    return [...this.users.values()].find((u) => u.email.toLowerCase() === needle) ?? null;
  }
  async create(user: User) {
    if (await this.findByEmail(user.email)) {
      throw new ConflictError(`email already registered: ${user.email}`);
    }
    this.users.set(user.id, user);
    return user;
  }
  async update(id: string, patch: Partial<User>) {
    const existing = this.users.get(id);
    if (!existing) throw new NotFoundError('user', id);
    const next = { ...existing, ...patch, id };
    this.users.set(id, next);
    return next;
  }
}

export class MemoryOrganizationRepository implements OrganizationRepository {
  constructor(private readonly orgs = new Map<string, Organization>()) {}

  async get(scope: TenantScope) {
    return this.orgs.get(scope.orgId) ?? null;
  }
  async findBySlug(slug: string) {
    return [...this.orgs.values()].find((o) => o.slug === slug) ?? null;
  }
  async findByVerifiedDomain(domain: string) {
    const needle = domain.toLowerCase();
    return (
      [...this.orgs.values()].find((o) =>
        o.verifiedDomains.some((d) => d.toLowerCase() === needle),
      ) ?? null
    );
  }
  async create(org: Organization) {
    if (await this.findBySlug(org.slug)) {
      throw new ConflictError(`organization slug taken: ${org.slug}`);
    }
    this.orgs.set(org.id, org);
    return org;
  }
  async update(scope: TenantScope, patch: Partial<Organization>) {
    const existing = this.orgs.get(scope.orgId);
    if (!existing) throw new NotFoundError('organization', scope.orgId);
    const next = { ...existing, ...patch, id: existing.id };
    this.orgs.set(next.id, next);
    return next;
  }
  async listChildren(scope: TenantScope) {
    return [...this.orgs.values()].filter((o) => o.parentOrgId === scope.orgId);
  }
}

export class MemoryWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly workspaces = new Map<string, Workspace>()) {}

  private scoped(scope: TenantScope): Workspace[] {
    return [...this.workspaces.values()].filter((w) => w.orgId === scope.orgId);
  }

  async list(scope: TenantScope, opts: ListOptions = {}) {
    const items = this.scoped(scope)
      .filter((w) => matches(opts.search, w.name, w.slug))
      .sort((a, b) => a.name.localeCompare(b.name));
    return paginate(items, opts);
  }

  async get(scope: TenantScope, workspaceId: string) {
    const ws = this.workspaces.get(workspaceId);
    // Cross-tenant read returns null, never the row.
    return ws && ws.orgId === scope.orgId ? ws : null;
  }

  async findBySlug(scope: TenantScope, slug: string) {
    return this.scoped(scope).find((w) => w.slug === slug) ?? null;
  }

  async create(scope: TenantScope, workspace: Workspace) {
    if (await this.findBySlug(scope, workspace.slug)) {
      throw new ConflictError(`workspace slug taken in this organization: ${workspace.slug}`);
    }
    const row = { ...workspace, orgId: scope.orgId };
    this.workspaces.set(row.id, row);
    return row;
  }

  async update(scope: WorkspaceScope, patch: Partial<Workspace>) {
    const existing = await this.get(scope, scope.workspaceId);
    if (!existing) throw new NotFoundError('workspace', scope.workspaceId);
    const next = { ...existing, ...patch, id: existing.id, orgId: existing.orgId };
    this.workspaces.set(next.id, next);
    return next;
  }

  async delete(scope: WorkspaceScope) {
    const existing = await this.get(scope, scope.workspaceId);
    if (!existing) throw new NotFoundError('workspace', scope.workspaceId);
    this.workspaces.delete(scope.workspaceId);
  }
}

export class MemoryAgentRepository implements AgentRepository {
  constructor(private readonly agents = new Map<string, Agent>()) {}

  private scoped(scope: WorkspaceScope): Agent[] {
    return [...this.agents.values()].filter(
      (a) => a.orgId === scope.orgId && a.workspaceId === scope.workspaceId,
    );
  }

  async list(scope: WorkspaceScope, opts: ListOptions = {}) {
    const items = this.scoped(scope)
      .filter((a) => matches(opts.search, a.name, a.description))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return paginate(items, opts);
  }

  async get(scope: WorkspaceScope, agentId: string) {
    const agent = this.agents.get(agentId);
    return agent && agent.orgId === scope.orgId && agent.workspaceId === scope.workspaceId
      ? agent
      : null;
  }

  async create(scope: WorkspaceScope, agent: Agent) {
    const row = { ...agent, orgId: scope.orgId, workspaceId: scope.workspaceId };
    this.agents.set(row.id, row);
    return row;
  }

  async update(scope: WorkspaceScope, agentId: string, patch: Partial<Agent>) {
    const existing = await this.get(scope, agentId);
    if (!existing) throw new NotFoundError('agent', agentId);
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      orgId: existing.orgId,
      workspaceId: existing.workspaceId,
      updatedAt: new Date().toISOString(),
    };
    this.agents.set(next.id, next);
    return next;
  }

  async delete(scope: WorkspaceScope, agentId: string) {
    const existing = await this.get(scope, agentId);
    if (!existing) throw new NotFoundError('agent', agentId);
    this.agents.delete(agentId);
  }
}
