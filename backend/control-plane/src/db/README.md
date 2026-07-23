# `src/db` — Postgres, RLS, retention

The storage layer for the control plane. Four things live here:

| File | What it is |
|---|---|
| `schema.ts` | Drizzle schema — the single TypeScript view of every table |
| `migrations/0001_init.sql` | Plain SQL: tables, constraints, indexes, FKs, RLS enablement |
| `rls.sql` | Roles, grants, and Row-Level Security policies |
| `client.ts` | Pool, `withTenant()`, graceful shutdown |

The repositories that use it are in `src/repositories/postgres/`.

---

## Running migrations

```bash
export DATABASE_URL='postgres://app_migrator@localhost:5432/voiceai'

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/0001_init.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/rls.sql
```

Order matters. `0001_init.sql` creates the tables and turns RLS **on**; `rls.sql`
creates the roles, the policies, and the grants. Between the two commands the
database is in the safest possible intermediate state — RLS enabled with no
policies means deny-all for every non-owner role.

`0001_init.sql` is wrapped in `BEGIN`/`COMMIT`: either the whole tenancy model
lands or none of it does. `ON_ERROR_STOP=1` is not optional — without it `psql`
happily continues past a failed `CREATE TABLE` and leaves you with half a schema.

### Two roles, and why

```
app_migrator   owns the tables, runs migrations, never used at runtime
app_user       the application connects as this — NOSUPERUSER, NOBYPASSRLS,
               and NOT the table owner
```

This split is load-bearing, not ceremony. A table's **owner is exempt from its own
RLS policies** unless `FORCE ROW LEVEL SECURITY` is set, and superusers and
`BYPASSRLS` roles are exempt unconditionally. If the application connects as
`postgres` or as the table owner, every policy in `rls.sql` is decorative. We set
`FORCE ROW LEVEL SECURITY` on every table as well, so even the owner is subject to
the policies — but the role split is the primary control.

The application's `DATABASE_URL` must point at `app_user`.

### Verifying it took

Three queries at the bottom of `rls.sql`. All three must return zero rows: every
table has RLS enabled *and* forced, every table with an `org_id` has a policy, and
`app_user` can neither bypass RLS nor is a superuser. Run them in CI after
migrating a scratch database — this is the kind of thing that regresses silently.

### Drizzle and the SQL

`schema.ts` is the type-level mirror of the migration; it is **not** the generator.
Migrations are hand-written SQL and reviewed as SQL, because the interesting parts
of this schema — partial indexes, `CHECK` constraints, `DESC` index ordering, RLS —
are things an ORM's DDL generator either cannot express or expresses badly. Drizzle
earns its place at query time, not at migration time.

If you change `schema.ts`, write the matching `000N_*.sql` by hand. The
`TENANT_SCOPED_TABLES` constant at the bottom of `schema.ts` exists so the two files
can be eyeballed against each other.

---

## How RLS is enforced

Full rationale is in the header comment of `rls.sql`. The short version:

Every tenant-scoped table has one policy:

```sql
USING      (org_id = app_current_org_id())
WITH CHECK (org_id = app_current_org_id())
```

`app_current_org_id()` reads `current_setting('app.current_org_id', true)`. The
`true` means "missing is not an error" — an unset variable returns `NULL`, `org_id
= NULL` is never true, and the query returns **zero rows**. It fails closed:
forgetting `withTenant` produces an obvious empty-result bug in development rather
than a silent full-table read in production.

`WITH CHECK` matters as much as `USING`. A `USING`-only policy would let an `UPDATE`
move a row *into* another tenant.

### Setting the session variable

`withTenant(orgId, fn)` in `client.ts`:

```sql
BEGIN;
  SELECT set_config('app.current_org_id', $1, true);   -- the `true` = SET LOCAL
  ...queries...
COMMIT;
```

Three properties, all required:

1. **Transaction-scoped.** Postgres clears a `SET LOCAL` at `COMMIT` *and* at
   `ROLLBACK`. A pooled connection can therefore never be handed to the next
   request still carrying the previous tenant's id. Using plain `SET` (session
   scope) here would be a critical bug — under any connection pool it leaks the
   tenant across unrelated requests, which is precisely the failure RLS exists to
   prevent.
2. **Parameterised.** `set_config($1, $2, true)` binds the org id. `SET LOCAL
   app.current_org_id = '…'` does not accept bind parameters and would need string
   interpolation. `withTenant` additionally rejects anything that is not
   `/^org_[a-z0-9]{4,64}$/`, which also catches "passed a workspace id by mistake".
3. **Same connection.** The `set_config` and the queries run inside one Drizzle
   transaction, therefore on one pooled client.

Every tenant-scoped repository method runs inside `withTenant`, even single-statement
reads.

### Why bother, when the repositories already filter?

Because the repository layer only stops the *predictable* mistakes. It does not stop
a raw `db.execute()` written at 2am for a support ticket, a new join whose alias
nobody constrained, an analytics query that groups before it filters, a backfill
script, or a human in `psql`. Each of those is a cross-tenant breach in a system
where the ORM is the only guard. With RLS on, the worst case is an empty result set.

The application filter and the database policy would both have to be wrong on the
same day, and they fail for uncorrelated reasons. The cost is one `SET LOCAL` per
transaction.

### The two deliberate exceptions

**`users`** has no `org_id` and no tenant policy. One human, one account, many orgs
— a user row has no single owning org, and login has to read the table before any
tenant is known. Membership is the tenant-scoped fact and it lives in
`org_memberships`, which *is* policied. RLS is still enabled on `users` with an
explicit permissive policy so the table shows up in a `pg_policies` audit as a
considered decision rather than an oversight.

**Org discovery.** `findBySlug` and `findByVerifiedDomain` take no scope by
signature, because they are how a scope gets discovered (docs/11 §5). Rather than
grant a pre-tenant `SELECT` on `organizations`, `rls.sql` defines two
`SECURITY DEFINER` functions that return **only an id** — never a row, never a
column. `PostgresOrganizationRepository` then re-reads the full record inside
`withTenant`, under the ordinary policy. Total disclosure: "an org with this slug
exists", which the login URL already told you.

---

## Retention and erasure

docs/13 §2 makes GDPR a P1 gate on the first EU enterprise deal, and the two
obligations that touch this schema are **storage limitation** (don't keep it longer
than the stated policy) and **right to erasure** (delete it on request, within a
month). Both are engineering problems here, not policy documents.

### Where the policy lives

`workspaces.compliance.retentionDays` (JSONB, 1–3650, `CHECK`-constrained). Retention
is a workspace property because the workspace is the compliance boundary — a German
healthcare brand and a US support line inside the same org need different answers.

### `calls.purge_after`

Written at INSERT as `started_at + retentionDays`. Denormalised on purpose:

* the sweep becomes one indexed range scan (`calls_purge_after_idx`, partial on
  `purge_after IS NOT NULL`) instead of a join to `workspaces` per row;
* shortening a retention policy does **not** silently re-date data already collected
  under the old one. Shortening applies going forward; re-stamping existing rows is
  an explicit, audited backfill. That is the defensible GDPR posture and it is also
  the one that doesn't surprise a customer by deleting last quarter's calls the
  moment they move a slider.

### The retention sweep (documented query, not a cron implementation)

Run per region, in batches, off-peak. Batching keeps lock duration bounded and lets
the job be killed and resumed at any point.

**1 — Recordings first.** Recordings are the largest and most sensitive artefact, and
they live in object storage, so the row can only record that they went.

```sql
-- Select a batch of calls whose recordings are due.
SELECT id, workspace_id, recording_url
  FROM calls
 WHERE purge_after <= now()
   AND recording_url IS NOT NULL
   AND recording_deleted_at IS NULL
   AND region = $1
 ORDER BY purge_after
 LIMIT 500
 FOR UPDATE SKIP LOCKED;   -- lets N workers run without stepping on each other

-- ...delete the objects from blob storage...

UPDATE calls
   SET recording_url = NULL,
       recording_deleted_at = now()
 WHERE id = ANY($2);
```

**2 — Transcripts.** Keep the shape of the conversation, drop the content. Nulling
`text` and keeping `text_redacted` means latency percentiles, containment rates, and
turn-count analytics survive a purge; the words do not.

```sql
UPDATE turns
   SET text = NULL, metadata = '{}'::jsonb
 WHERE call_id IN (
   SELECT id FROM calls
    WHERE purge_after <= now() AND region = $1
    ORDER BY purge_after LIMIT 500
 );
```

**3 — Call rows.** Either hard-delete (`turns` cascade) or strip the PII columns and
keep the aggregate. Most customers want the second; both are one statement.

```sql
-- Anonymise, keep the metrics:
UPDATE calls
   SET from_e164 = NULL, to_e164 = NULL, consent = NULL,
       metadata  = '{}'::jsonb,
       lead_id   = NULL,
       pii_redacted = true,
       purge_after  = NULL          -- drops out of the partial index
 WHERE purge_after <= now() AND region = $1;

-- Or hard delete, cascading to turns:
DELETE FROM calls WHERE purge_after <= now() AND region = $1;
```

**4 — Leads.** `leads.consent` and `leads.phone` age out with the campaign under the
same workspace policy.

Every sweep pass writes one `audit_log` row per workspace: `action =
'retention.sweep'`, `after = {rows, region, cutoff}`. "We deleted it on schedule" is
only true if you can show it.

### Right to erasure (DSAR)

A data-subject request names a **person**, not a workspace, so erasure runs across
tables by identifier rather than by deadline. In GDPR terms our customer is the
controller and we are the processor: they receive the request, we execute it, and we
have a month.

**End user (a caller — the common case).** Identified by phone number:

```sql
-- 1. Find their calls, org-scoped.
SELECT id FROM calls
 WHERE workspace_id = $1 AND (from_e164 = $2 OR to_e164 = $2);

-- 2. Recordings: delete the objects, then
UPDATE calls SET recording_url = NULL, recording_deleted_at = now() WHERE id = ANY($3);

-- 3. Transcripts: drop the verbatim text, keep the redacted skeleton.
UPDATE turns SET text = NULL WHERE call_id = ANY($3);

-- 4. Identifiers on the call rows.
UPDATE calls SET from_e164 = NULL, to_e164 = NULL, consent = NULL,
                 metadata = '{}'::jsonb, pii_redacted = true
 WHERE id = ANY($3);

-- 5. Lead records.
DELETE FROM leads WHERE workspace_id = $1 AND e164 = $2;
```

**Platform user (someone with an account).** `users.deleted_at` is a tombstone: the
row survives so foreign keys and audit history stay intact, and the PII columns are
overwritten in place.

```sql
UPDATE users
   SET email = 'erased+' || id || '@invalid',
       first_name = 'Erased', family_name = 'User',
       job_title = NULL, phone = NULL, avatar_url = NULL,
       email_verified = false,
       deleted_at = now()
 WHERE id = $1;

DELETE FROM org_memberships       WHERE user_id = $1;
DELETE FROM workspace_memberships WHERE user_id = $1;
```

Note what is **not** erased: `audit_log.actor_user_id` keeps the (now opaque) id.
Article 17 is not absolute — records required to establish or defend legal claims,
and records kept under a separate legal obligation, are exempt. An audit trail with
holes punched in it is not an audit trail. The identifier that remains resolves to a
tombstoned row with no personal data in it.

Every erasure writes its own `audit_log` entry (`action = 'gdpr.erasure'`) recording
what was erased and when. That entry is the evidence of compliance.

### Residency

`calls.region` is denormalised from the workspace so residency is a property of the
record itself, not something you have to join to discover. The control plane is
global; the data plane is regional (docs/10 §Region & residency). Sweeps and DSARs
are parameterised by region so they run inside the cell that holds the data and
never pull EU rows through a US process.

---

## The audit log is append-only

`audit_log` is granted `SELECT, INSERT` and **nothing else**:

```sql
GRANT  SELECT, INSERT ON audit_log TO app_user;
REVOKE UPDATE, DELETE  ON audit_log FROM app_user;
```

Not "we don't update it" — the application role does not hold the privilege, so it
cannot. There is also no `FOR UPDATE` or `FOR DELETE` policy, so the RLS layer would
deny it even if a grant appeared by accident. Two independent locks.

An audit trail the application can rewrite is not evidence. "Immutable audit log" is
a literal line item in SOC 2 and in every EU enterprise security questionnaire
(docs/13 §2).

Consequences worth knowing:

* **No foreign keys on `audit_log`.** An audit record must survive the deletion of
  the thing it describes; that is most of the point of having one. `org_id` and
  `target_id` are plain `text`.
* **Sequential `bigserial` id**, not a prefixed string. No API addresses an audit row
  by id, and a gapless sequence makes tampering visible.
* **Pruning is not an application capability.** When the retention schedule
  eventually requires trimming the audit log, it runs as a separate role under a
  documented, itself-audited procedure.

`agent_versions` is revoked the same way, for the same reason: a published version
must mean the same thing forever, or "which prompt was live on 3 March" becomes
unanswerable.

---

## Where the Zod schema and a sensible SQL type disagreed

Five places. Each is resolved at the mapper boundary
(`src/repositories/postgres/mappers.ts`), never by bending the domain.

**1. `null` vs `undefined`.** SQL nullable columns come back as `null`; Zod models
the same fields as `.optional()`, i.e. `undefined`, and `z.optional()` *rejects*
`null`. `nn()` and `nu()` in the mappers normalise in both directions. The only
field where the domain genuinely wants `null` is `organizations.parent_org_id`
(`.nullable().optional()`), which passes through untouched — and correctly so, since
"has no parent" is a meaningful state, not a missing value.

**2. Timestamps: `timestamptz` vs `z.string().datetime()`.** Columns are
`timestamptz` because Postgres should store an absolute instant, not a wall clock.
The domain uses ISO-8601 strings because that is the wire contract. Drizzle is
configured `mode: 'date'` and the mappers call `.toISOString()`, which always emits
UTC with a `Z` — exactly what `z.string().datetime()` accepts. We do **not** use
Drizzle's `mode: 'string'`: it hands back Postgres's native rendering
(`2026-03-01 12:00:00+00`), which `z.string().datetime()` rejects.

**3. Enums: Zod `z.enum` vs `CHECK` constraints, not PG enum types.** Region, role,
status, mode and friends are `text` + `CHECK`. Adding a region to a `CHECK` is a
one-line `ALTER`; adding a value to a PG enum type is a migration with locking
semantics that vary by version, and enum types cannot have values removed at all.
Type safety is recovered in TypeScript with Drizzle's `.$type<Region>()`.

**4. Nested objects: Zod objects vs JSONB.** `complianceProfile`, `spendCaps`,
`voice`, `pipeline`, `tools[]`, `phone`, `address` are `jsonb` with `.$type<>()`.
They are configuration read as a unit, never queried field-by-field, and normalising
them would buy joins and nothing else. One exception is promoted out of JSONB into a
`CHECK`: `compliance->>'retentionDays'` is constrained to 1–3650 at the database
level, because the retention sweep depends on it and a malformed value there is a
compliance incident rather than a validation error.

**5. Zod `.default()` vs SQL `DEFAULT`.** Both are declared, deliberately. Zod
defaults apply to data entering through the API; SQL defaults apply to every other
writer, including migrations and support scripts. The values are kept identical, and
where they can drift (`agents.stats`) the column is `NOT NULL` with a `'{}'` default
so a row can never exist without one.

Two smaller notes:

* **`money` is `numeric(12,6)`, never `float`.** `calls.cost_usd` at
  micro-dollar precision. Per-call costs are fractions of a cent and they get summed
  across millions of rows; IEEE-754 has no business anywhere near a bill.
* **`verified_domains` is `text[]`, not a child table.** Short list, always read
  whole, and GIN-indexed for the one query that matters — "which org owns this email
  domain".

---

## Wiring it into the container

`src/repositories/postgres/index.ts` exports everything needed:

```ts
import {
  createDb, registerShutdown,
  PostgresUserRepository, PostgresOrganizationRepository,
  PostgresWorkspaceRepository, PostgresAgentRepository,
} from './repositories/postgres/index.js';

const handle = createDb();                 // reads DATABASE_URL
registerShutdown(handle);

const repositories = {
  users:      new PostgresUserRepository(handle),
  orgs:       new PostgresOrganizationRepository(handle),
  workspaces: new PostgresWorkspaceRepository(handle),
  agents:     new PostgresAgentRepository(handle),
};
```

The four classes satisfy the interfaces in `src/repositories/types.ts` exactly, and
reproduce `memory.ts`'s semantics including `ConflictError`/`NotFoundError` and the
rule that a cross-tenant `get()` returns `null` rather than the row.
