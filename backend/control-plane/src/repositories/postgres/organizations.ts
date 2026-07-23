/**
 * PostgresOrganizationRepository.
 *
 * Two of the five methods on `OrganizationRepository` are, by their signature,
 * pre-tenant lookups: `findBySlug` and `findByVerifiedDomain` take no scope because
 * they are how a scope gets discovered in the first place — a user types an org URL,
 * or signs up with an email whose domain some org has verified (docs/11 §5).
 *
 * Under RLS that is a genuine conflict: with no `app.current_org_id` set, `SELECT *
 * FROM organizations` correctly returns nothing. We resolve it without punching a
 * hole in the policy, via two SECURITY DEFINER functions (`rls.sql` §Discovery) that
 * return only an ID — never a row. The repository then re-reads the full record
 * inside `withTenant`, subject to the ordinary policy.
 *
 * The information disclosed is therefore exactly "an org with this slug exists",
 * which the login URL already tells you, and nothing else. A leaked or brute-forced
 * slug yields an opaque id and no data.
 */

import { eq, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { organizations } from '../../db/schema.js';
import type { Organization } from '../../domain/schemas.js';
import type { TenantScope } from '../../domain/tenant.js';
import type { OrganizationRepository } from '../types.js';
import { ConflictError, NotFoundError } from '../types.js';
import {
  isUniqueViolation,
  organizationPatchToRow,
  organizationToRow,
  rowToOrganization,
} from './mappers.js';

export class PostgresOrganizationRepository implements OrganizationRepository {
  constructor(private readonly handle: DbHandle) {}

  /** Scoped read. RLS makes this a no-op for any org but the caller's own. */
  async get(scope: TenantScope): Promise<Organization | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, scope.orgId))
        .limit(1);
      const row = rows[0];
      return row ? rowToOrganization(row) : null;
    });
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    const orgId = await this.lookupId(sql`select app_lookup_org_by_slug(${slug}) as id`);
    return orgId ? this.readById(orgId) : null;
  }

  async findByVerifiedDomain(domain: string): Promise<Organization | null> {
    const orgId = await this.lookupId(
      sql`select app_lookup_org_by_verified_domain(${domain.toLowerCase()}) as id`,
    );
    return orgId ? this.readById(orgId) : null;
  }

  async create(org: Organization): Promise<Organization> {
    // Creating an org is the one write that cannot already be inside a tenant: the
    // tenant is what it produces. We set the variable to the id we are about to
    // insert so the policy's WITH CHECK passes for the new row.
    return this.handle.withTenant(org.id, async (db) => {
      try {
        const rows = await db.insert(organizations).values(organizationToRow(org)).returning();
        const row = rows[0];
        if (!row) throw new Error('insert returned no row');
        return rowToOrganization(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(`organization slug taken: ${org.slug}`);
        }
        throw err;
      }
    });
  }

  async update(scope: TenantScope, patch: Partial<Organization>): Promise<Organization> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const values = organizationPatchToRow(patch);
      if (Object.keys(values).length === 0) {
        const existing = await db
          .select()
          .from(organizations)
          .where(eq(organizations.id, scope.orgId))
          .limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('organization', scope.orgId);
        return rowToOrganization(row);
      }

      try {
        const rows = await db
          .update(organizations)
          .set(values)
          .where(eq(organizations.id, scope.orgId))
          .returning();
        const row = rows[0];
        if (!row) throw new NotFoundError('organization', scope.orgId);
        return rowToOrganization(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(`organization slug taken: ${patch.slug ?? ''}`);
        }
        throw err;
      }
    });
  }

  /**
   * Reseller/BPO tree (docs/12 §5). Readable because of the `organizations_child_read`
   * policy, which is SELECT-only and matches exactly one level down. A parent can
   * enumerate its children; it cannot write them, and it cannot see its siblings.
   */
  async listChildren(scope: TenantScope): Promise<Organization[]> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(organizations)
        .where(eq(organizations.parentOrgId, scope.orgId))
        .orderBy(organizations.name);
      return rows.map(rowToOrganization);
    });
  }

  // -- internals ------------------------------------------------------------

  private async lookupId(query: ReturnType<typeof sql>): Promise<string | null> {
    return this.handle.unscoped(async (db) => {
      const result = await db.execute(query);
      const first = result.rows[0] as { id?: string | null } | undefined;
      return first?.id ?? null;
    });
  }

  private async readById(orgId: string): Promise<Organization | null> {
    return this.handle.withTenant(orgId, async (db) => {
      const rows = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      const row = rows[0];
      return row ? rowToOrganization(row) : null;
    });
  }
}
