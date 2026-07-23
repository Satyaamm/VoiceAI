-- ===========================================================================
-- Row-Level Security — the second line of defence.
--
-- docs/10 §Scoping rules, rule 2:
--   "Postgres RLS policies on org_id as a second line of defence, so an ORM
--    mistake can't leak across tenants."
--
-- WHY THIS FILE EXISTS EVEN THOUGH THE REPOSITORIES ALREADY FILTER
-- ---------------------------------------------------------------------------
-- The repository layer is genuinely good at this: every method takes a
-- `TenantScope` as its first argument, `TenantScope` is unforgeable (branded with
-- a non-exported symbol, `authorize()` is the only producer), and there is no
-- `findAll()`. That stops the *predictable* mistakes.
--
-- It does not stop:
--   * a raw `db.execute(sql\`...\`)` written at 2am for a support ticket;
--   * a new join added to an existing query that pulls in a table whose alias
--     nobody remembered to constrain;
--   * an aggregate/analytics query that groups before it filters;
--   * a future ORM upgrade that changes how a `where` on a nullable column is
--     compiled;
--   * a migration script, a backfill job, or a psql session run by a human;
--   * any code path that receives an `orgId` from the wrong variable.
--
-- Every one of those is a cross-tenant data breach in a system where the ORM is
-- the only guard. With RLS on, the worst case is an empty result set. The
-- application filter and the database policy have to BOTH be wrong on the same
-- day for data to leak, and they fail for uncorrelated reasons.
--
-- The cost is one `SET LOCAL` per transaction. That is a rounding error, and it
-- buys the answer to the first question every enterprise security review asks.
--
--
-- HOW THE APPLICATION SETS THE SESSION VARIABLE
-- ---------------------------------------------------------------------------
-- Policies read `current_setting('app.current_org_id', true)`. The application
-- sets it per TRANSACTION, never per connection:
--
--     BEGIN;
--       SELECT set_config('app.current_org_id', 'org_7fk2m9qp3x1a', true);
--       -- ^ the `true` makes it SET LOCAL: transaction-scoped.
--       ... queries ...
--     COMMIT;
--
-- This is `withTenant(orgId, fn)` in `src/db/client.ts`. Three properties matter:
--
--   1. TRANSACTION-SCOPED. Postgres clears a `SET LOCAL` at COMMIT and at
--      ROLLBACK. A pooled connection therefore can NEVER be handed to the next
--      request still carrying the previous tenant's id. Setting it with plain
--      `SET` (session-scoped) would be a critical bug — under pgbouncer or any
--      pool it would leak the tenant across unrelated requests.
--   2. PARAMETERISED. `set_config($1, $2, true)` takes the org id as a bind
--      parameter. `SET LOCAL app.current_org_id = '...'` does not accept bind
--      parameters and would require string interpolation.
--   3. THE THIRD ARGUMENT to `current_setting(name, missing_ok)` is `true`, so an
--      unset variable raises no error — it returns NULL, and every policy below
--      then matches zero rows. FAIL CLOSED: forgetting `withTenant` makes queries
--      return nothing, which surfaces as an obvious bug in development rather
--      than as a silent full-table read in production.
--
--
-- THE ROLE MODEL
-- ---------------------------------------------------------------------------
--   app_user     the application connects as this. NOSUPERUSER, NOBYPASSRLS,
--                not the table owner. This is load-bearing: a table's OWNER is
--                exempt from its own RLS policies unless FORCE ROW LEVEL
--                SECURITY is set, and superusers and BYPASSRLS roles are exempt
--                unconditionally. If the app connects as the owner or as
--                postgres, every policy in this file is decorative.
--   app_migrator owns the tables, runs migrations. Not used at runtime.
--
-- We additionally set FORCE ROW LEVEL SECURITY on every table so that even the
-- owner is subject to the policies — belt and braces for the case where someone
-- points the app at the migrator role.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Roles (idempotent; adjust passwords/auth to your environment)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator LOGIN NOINHERIT;
  END IF;
END
$$;

-- Neither role may bypass RLS. Assert it loudly rather than assume it.
ALTER ROLE app_user     NOBYPASSRLS NOSUPERUSER;
ALTER ROLE app_migrator NOBYPASSRLS NOSUPERUSER;


-- ---------------------------------------------------------------------------
-- The predicate, once.
--   current_setting(..., true) -> NULL when unset -> `org_id = NULL` -> no rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.current_org_id', true), '') $$;

COMMENT ON FUNCTION app_current_org_id() IS
  'Tenant key for RLS. Set per transaction by withTenant() in src/db/client.ts via '
  'SET LOCAL. Returns NULL when unset, which makes every tenant policy match zero rows.';


-- ---------------------------------------------------------------------------
-- Tenant-scoped tables: enable, force, policy.
--
-- One policy per table covering ALL commands. USING governs which existing rows
-- are visible to SELECT/UPDATE/DELETE; WITH CHECK governs which rows INSERT and
-- UPDATE are allowed to write. Both are required — a USING-only policy lets an
-- UPDATE move a row into another tenant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'organizations',
    'workspaces',
    'org_memberships',
    'workspace_memberships',
    'invitations',
    'api_keys',
    'agents',
    'agent_versions',
    'phone_numbers',
    'campaigns',
    'leads',
    'calls',
    'turns'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        FOR ALL
        TO app_user
        USING      (org_id = app_current_org_id())
        WITH CHECK (org_id = app_current_org_id())
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- `organizations` needs one extra read path: a reseller/BPO parent org legitimately
-- needs to LIST its children (docs/12 §5, OrganizationRepository.listChildren).
-- Read-only, one level, and only for rows whose parent is the current tenant.
DROP POLICY IF EXISTS organizations_child_read ON organizations;
CREATE POLICY organizations_child_read ON organizations
  FOR SELECT
  TO app_user
  USING (parent_org_id = app_current_org_id());


-- ---------------------------------------------------------------------------
-- Discovery — the chicken-and-egg case.
--
-- `OrganizationRepository.findBySlug` and `.findByVerifiedDomain` take no scope,
-- because they are how a scope is DISCOVERED: a user opens /orgs/acme, or signs
-- up with alice@acme.com and we need to know whether some org has verified
-- acme.com (docs/11 §5). At that moment there is no tenant to set.
--
-- Rather than granting a pre-tenant SELECT on `organizations` — which would let
-- any authenticated request enumerate every customer's billing address — these
-- two SECURITY DEFINER functions return ONLY AN ID. Never a row, never a column.
-- The repository then re-reads the full record inside withTenant(), under the
-- ordinary policy.
--
-- The total disclosure is "an org with this slug/domain exists", which the login
-- URL already tells you. A brute-forced slug yields an opaque id and no data.
--
-- SECURITY DEFINER + a pinned empty search_path: the function body must not be
-- resolvable against a caller-controlled schema.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_lookup_org_by_slug(p_slug text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT id FROM organizations
   WHERE slug = p_slug AND deleted_at IS NULL
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app_lookup_org_by_verified_domain(p_domain text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT id FROM organizations
   WHERE deleted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM unnest(verified_domains) d WHERE lower(d) = lower(p_domain)
     )
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION app_lookup_org_by_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_lookup_org_by_verified_domain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lookup_org_by_slug(text) TO app_user;
GRANT EXECUTE ON FUNCTION app_lookup_org_by_verified_domain(text) TO app_user;


-- ---------------------------------------------------------------------------
-- audit_log — tenant-isolated AND append-only.
--
-- Two separate policies rather than FOR ALL, because the whole point is that the
-- verbs are not symmetrical: INSERT and SELECT yes, UPDATE and DELETE never.
-- The policies are the second lock; the missing GRANT below is the first.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_tenant_read ON audit_log;
CREATE POLICY audit_log_tenant_read ON audit_log
  FOR SELECT TO app_user
  USING (org_id = app_current_org_id());

DROP POLICY IF EXISTS audit_log_append ON audit_log;
CREATE POLICY audit_log_append ON audit_log
  FOR INSERT TO app_user
  WITH CHECK (org_id = app_current_org_id());

-- No FOR UPDATE and no FOR DELETE policy exists, by design.


-- ---------------------------------------------------------------------------
-- users — deliberately NOT tenant-scoped.
--
-- One human, one account, many orgs. A user row has no single owning org, so
-- there is no honest `org_id` to policy on; membership is the tenant-scoped fact
-- and that lives in `org_memberships`, which IS policied. Login and signup have
-- to read this table before any tenant is known.
--
-- RLS stays enabled with a permissive policy so that the table shows up in
-- `pg_policies` audits as a considered decision rather than an oversight.
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_global ON users;
CREATE POLICY users_global ON users FOR ALL TO app_user USING (true) WITH CHECK (true);


-- ---------------------------------------------------------------------------
-- Grants. The privilege model and the policy model are independent: a policy can
-- only narrow what a GRANT already allows.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, organizations, workspaces, org_memberships, workspace_memberships,
  invitations, api_keys, agents, agent_versions, phone_numbers, campaigns,
  leads, calls, turns
TO app_user;

-- APPEND-ONLY AUDIT LOG.
-- Note what is absent: no UPDATE, no DELETE. Not "we don't do it" — the app role
-- is not granted the privilege, so it cannot. An audit trail the application can
-- rewrite is not evidence, and "immutable audit log" is a literal line item in
-- SOC 2 and in every EU enterprise security questionnaire (docs/13 §2).
--
-- Retention pruning of audit_log, when the schedule eventually requires it, runs
-- as a separate role under a documented, itself-audited procedure. It is not an
-- application capability.
GRANT SELECT, INSERT ON audit_log TO app_user;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO app_user;

REVOKE UPDATE, DELETE ON audit_log FROM app_user;

-- agent_versions are immutable snapshots — a published version must mean the same
-- thing forever, or "which prompt was live on 3 March" becomes unanswerable.
REVOKE UPDATE, DELETE ON agent_versions FROM app_user;

-- New tables must not silently default to accessible.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;


-- ---------------------------------------------------------------------------
-- Verification — run after any migration. Both queries must return zero rows.
-- ---------------------------------------------------------------------------
-- 1. Every table has RLS enabled and forced:
--
--   SELECT c.relname
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind = 'r'
--      AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
--
-- 2. Every table with an org_id column actually has a policy on it:
--
--   SELECT c.relname
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
--    WHERE n.nspname = 'public' AND c.relkind = 'r'
--      AND NOT EXISTS (SELECT 1 FROM pg_policies p
--                       WHERE p.schemaname = 'public' AND p.tablename = c.relname);
--
-- 3. The app role cannot bypass RLS:
--
--   SELECT rolname FROM pg_roles
--    WHERE rolname = 'app_user' AND (rolbypassrls OR rolsuper);
-- ---------------------------------------------------------------------------
