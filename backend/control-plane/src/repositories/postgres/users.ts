/**
 * PostgresUserRepository.
 *
 * Users are global — one human, one account, many orgs — so this is the one
 * repository whose methods take no `TenantScope`, and `users` is the one table with
 * no `org_id` and therefore no tenant RLS policy. Membership is the tenant-scoped
 * fact and it lives in `org_memberships`.
 *
 * Behaviour is identical to `MemoryUserRepository`, including the error types.
 */

import { eq, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { users } from '../../db/schema.js';
import type { User } from '../../domain/schemas.js';
import type { UserRepository } from '../types.js';
import { ConflictError, NotFoundError } from '../types.js';
import { isUniqueViolation, rowToUser, userPatchToRow, userToRow } from './mappers.js';

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly handle: DbHandle) {}

  async findById(id: string): Promise<User | null> {
    return this.handle.unscoped(async (db) => {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      const row = rows[0];
      return row ? rowToUser(row) : null;
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.handle.unscoped(async (db) => {
      // lower(email) matches `users_email_lower_uq`, so this is an index scan.
      const rows = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = lower(${email})`)
        .limit(1);
      const row = rows[0];
      return row ? rowToUser(row) : null;
    });
  }

  async create(user: User): Promise<User> {
    return this.handle.unscoped(async (db) => {
      try {
        const rows = await db.insert(users).values(userToRow(user)).returning();
        const row = rows[0];
        if (!row) throw new Error('insert returned no row');
        return rowToUser(row);
      } catch (err) {
        // Check-then-insert races; the unique index is the real arbiter, so we
        // translate its violation rather than pre-checking and hoping.
        if (isUniqueViolation(err)) {
          throw new ConflictError(`email already registered: ${user.email}`);
        }
        throw err;
      }
    });
  }

  async update(id: string, patch: Partial<User>): Promise<User> {
    return this.handle.unscoped(async (db) => {
      const values = userPatchToRow(patch);
      // An empty patch must still behave like the memory version: return the row,
      // or throw NotFoundError. Drizzle rejects an UPDATE with no SET clause.
      if (Object.keys(values).length === 0) {
        const existing = await db.select().from(users).where(eq(users.id, id)).limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('user', id);
        return rowToUser(row);
      }

      try {
        const rows = await db.update(users).set(values).where(eq(users.id, id)).returning();
        const row = rows[0];
        if (!row) throw new NotFoundError('user', id);
        return rowToUser(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(`email already registered: ${patch.email ?? ''}`);
        }
        throw err;
      }
    });
  }
}
