/**
 * Postgres connection pool, tenant transaction helper, graceful shutdown.
 *
 * The important thing in this file is `withTenant`. RLS is only a defence if the
 * session variable it reads is set on the same connection that runs the query, for
 * the duration of exactly one transaction, and is guaranteed to be cleared when that
 * transaction ends. `SET LOCAL` gives us all three for free — it is scoped to the
 * transaction and Postgres unsets it at COMMIT or ROLLBACK, so a pooled connection
 * can never be handed to the next request still carrying the previous tenant's id.
 *
 * That is why every tenant-scoped repository method in `repositories/postgres/*`
 * runs inside `withTenant`, even for a single-statement read.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/** The session variable RLS policies read. Must match `rls.sql` exactly. */
export const TENANT_SETTING = 'app.current_org_id';

export interface DbConfig extends PoolConfig {
  /** Postgres URL. Falls back to DATABASE_URL. */
  connectionString?: string | undefined;
}

export interface DbHandle {
  pool: Pool;
  db: Database;
  /** Run `fn` in a transaction with the tenant session variable set. */
  withTenant<T>(orgId: string, fn: (tx: Database) => Promise<T>): Promise<T>;
  /**
   * Escape hatch for the handful of genuinely cross-tenant operations: signup,
   * login, `findByEmail`, `findBySlug`, `findByVerifiedDomain`. Named loudly so it
   * shows up in review. It does NOT bypass RLS — it simply never sets the tenant
   * variable, which for `BYPASSRLS`-less roles means tenant-scoped tables return
   * zero rows. Only use it for tables with no `org_id` (`users`) or for the
   * deliberately-global lookups the migration exempts.
   */
  unscoped<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  /** Drain the pool. Idempotent. */
  close(): Promise<void>;
  /** `SELECT 1`, for the readiness probe. */
  ping(): Promise<boolean>;
}

/**
 * `orgId` is interpolated into a `set_config` CALL, never into SQL text, so a
 * hostile id cannot escape the statement. We also reject anything that is not a
 * plausible prefixed id — defence in depth, and it catches the "passed a workspace
 * id by mistake" bug at the boundary.
 */
function assertOrgId(orgId: string): string {
  if (!/^org_[a-z0-9]{4,64}$/.test(orgId)) {
    throw new Error(`withTenant: expected an org id (org_…), got "${orgId}"`);
  }
  return orgId;
}

export function createDb(config: DbConfig = {}): DbHandle {
  const connectionString = config.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — the Postgres repositories need a connection.');
  }

  const pool = new Pool({
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Statement timeout keeps a runaway analytics query from pinning a connection.
    statement_timeout: 15_000,
    ...config,
    connectionString,
  });

  // A pool error is emitted for idle clients; without a listener Node treats it as
  // an unhandled 'error' event and exits the process.
  pool.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', err: err.message }));
  });

  const db = drizzle(pool, { schema });

  let closed = false;

  async function withTenant<T>(orgId: string, fn: (tx: Database) => Promise<T>): Promise<T> {
    const id = assertOrgId(orgId);
    return db.transaction(async (tx) => {
      // SET LOCAL: transaction-scoped, auto-cleared at COMMIT/ROLLBACK.
      // set_config(..., true) is the parameterisable form of SET LOCAL.
      await tx.execute(sql`select set_config(${TENANT_SETTING}, ${id}, true)`);
      return fn(tx as unknown as Database);
    });
  }

  async function unscoped<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => fn(tx as unknown as Database));
  }

  async function ping(): Promise<boolean> {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('select 1');
      return true;
    } catch {
      return false;
    } finally {
      client?.release();
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await pool.end();
  }

  return { pool, db, withTenant, unscoped, close, ping };
}

/**
 * Wire SIGINT/SIGTERM to a clean drain. Called from `main.ts` if and when the
 * Postgres repositories are switched on in the container.
 */
export function registerShutdown(handle: DbHandle, onDone?: () => void): () => void {
  let shuttingDown = false;
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => onDone?.());
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('beforeExit', stop);
  return stop;
}
