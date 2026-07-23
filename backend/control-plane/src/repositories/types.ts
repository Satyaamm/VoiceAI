/**
 * Repository interfaces.
 *
 * Every method takes a scope as its FIRST argument. There is deliberately no
 * `findAll()` and no `findById(id)` without a scope — cross-tenant reads are a
 * compile error, not a code-review catch.
 */

import type { TenantScope, WorkspaceScope } from '../domain/tenant.js';
import type { Agent, Organization, User, Workspace } from '../domain/schemas.js';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListOptions {
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(user: User): Promise<User>;
  update(id: string, patch: Partial<User>): Promise<User>;
}

export interface OrganizationRepository {
  /** Scoped: you can only read the org you're authorized into. */
  get(scope: TenantScope): Promise<Organization | null>;
  findBySlug(slug: string): Promise<Organization | null>;
  /** For domain-based org discovery — docs/11 §5. */
  findByVerifiedDomain(domain: string): Promise<Organization | null>;
  create(org: Organization): Promise<Organization>;
  update(scope: TenantScope, patch: Partial<Organization>): Promise<Organization>;
  /** Reseller/BPO tree — docs/12 §5. */
  listChildren(scope: TenantScope): Promise<Organization[]>;
}

export interface WorkspaceRepository {
  list(scope: TenantScope, opts?: ListOptions): Promise<Page<Workspace>>;
  get(scope: TenantScope, workspaceId: string): Promise<Workspace | null>;
  findBySlug(scope: TenantScope, slug: string): Promise<Workspace | null>;
  create(scope: TenantScope, workspace: Workspace): Promise<Workspace>;
  update(scope: WorkspaceScope, patch: Partial<Workspace>): Promise<Workspace>;
  delete(scope: WorkspaceScope): Promise<void>;
}

export interface AgentRepository {
  list(scope: WorkspaceScope, opts?: ListOptions): Promise<Page<Agent>>;
  get(scope: WorkspaceScope, agentId: string): Promise<Agent | null>;
  create(scope: WorkspaceScope, agent: Agent): Promise<Agent>;
  update(scope: WorkspaceScope, agentId: string, patch: Partial<Agent>): Promise<Agent>;
  delete(scope: WorkspaceScope, agentId: string): Promise<void>;
}

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
