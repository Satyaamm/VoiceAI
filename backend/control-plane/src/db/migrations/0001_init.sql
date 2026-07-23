-- ===========================================================================
-- 0001_init — control plane schema.
--
-- Plain SQL, hand-written, reviewable. Run inside a single transaction: either
-- the whole tenancy model lands or none of it does.
--
-- Conventions:
--   * ids are prefixed strings (`org_…`, `ws_…`, `agt_…`) held in `text`.
--     Not uuid: uuids are unreadable in logs and say nothing about their kind.
--     Not serial: sequential ids leak volume and are guessable across tenants.
--     Generated in the application (src/domain/ids.ts) so prefix and entity kind
--     cannot drift.
--   * all timestamps are `timestamptz`, always UTC.
--   * every operational table carries BOTH org_id and workspace_id, denormalised.
--     RLS needs a column it can policy on without a subquery.
--   * money is `numeric`, never float.
--
-- Run `rls.sql` AFTER this file. Enablement lives at the bottom here; the
-- policies, roles, and grants live there.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- users — global, not tenant-scoped. One human, one account, many orgs.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              text        PRIMARY KEY,
  email           text        NOT NULL,
  email_verified  boolean     NOT NULL DEFAULT false,
  first_name      text        NOT NULL,
  family_name     text        NOT NULL,
  job_title       text,
  phone           jsonb,
  avatar_url      text,
  timezone        text        NOT NULL DEFAULT 'UTC',
  locale          text        NOT NULL DEFAULT 'en-US',
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- GDPR erasure tombstone. The row survives so foreign keys and audit history
  -- stay intact; the PII columns are overwritten. See README §Right to erasure.
  deleted_at      timestamptz,

  CONSTRAINT users_id_prefix CHECK (id LIKE 'usr\_%')
);

-- Case-insensitive uniqueness without the citext extension. The application
-- lowercases on write too; this is the guarantee, not the convention.
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- ---------------------------------------------------------------------------
-- organizations — the legal entity.
-- parent_org_id is the reseller/BPO hook (docs/12). One nullable column, added on
-- day one because retrofitting it means migrating live customer data.
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id               text        PRIMARY KEY,
  parent_org_id    text        REFERENCES organizations(id) ON DELETE SET NULL,
  name             text        NOT NULL,
  legal_name       text,
  slug             text        NOT NULL,
  website          text,
  industry         text,
  size             text,
  country          char(2)     NOT NULL,
  address          jsonb,
  phone            jsonb,
  tax_id           text,
  billing_email    text,
  timezone         text        NOT NULL DEFAULT 'UTC',
  currency         char(3)     NOT NULL DEFAULT 'USD',
  logo_url         text,
  verified_domains text[]      NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,

  CONSTRAINT organizations_id_prefix CHECK (id LIKE 'org\_%'),
  CONSTRAINT organizations_slug_fmt  CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  CONSTRAINT organizations_country_fmt CHECK (country ~ '^[A-Z]{2}$'),
  -- An org cannot be its own parent. Deeper cycles are prevented in the service
  -- layer; SQL cannot express "no cycles" without a trigger, and one level is all
  -- the product supports.
  CONSTRAINT organizations_no_self_parent CHECK (parent_org_id IS DISTINCT FROM id)
);

CREATE UNIQUE INDEX organizations_slug_uq   ON organizations (slug);
CREATE INDEX        organizations_parent_idx ON organizations (parent_org_id)
  WHERE parent_org_id IS NOT NULL;
-- Domain-based org discovery: "which org owns @acme.com" (docs/11 §5).
CREATE INDEX organizations_verified_domains_gin ON organizations USING gin (verified_domains);

-- ---------------------------------------------------------------------------
-- workspaces — the business boundary. Region, spend caps, compliance profile.
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id            text        PRIMARY KEY,
  org_id        text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  slug          text        NOT NULL,
  description   text,
  region        text        NOT NULL,
  region_locked boolean     NOT NULL DEFAULT false,
  compliance    jsonb       NOT NULL,
  spend_caps    jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,

  CONSTRAINT workspaces_id_prefix CHECK (id LIKE 'ws\_%'),
  CONSTRAINT workspaces_slug_fmt  CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  -- Enumerations live in CHECK constraints, not PG enum types: adding a region to
  -- a CHECK is a one-line ALTER, adding a value to an enum type is a migration
  -- with locking semantics that differ by PG version.
  CONSTRAINT workspaces_region CHECK (region IN ('us-east','us-west','eu-west','eu-central')),
  -- The retention policy the sweep depends on must always be present and sane.
  CONSTRAINT workspaces_retention CHECK (
    (compliance->>'retentionDays')::int BETWEEN 1 AND 3650
  )
);

CREATE UNIQUE INDEX workspaces_org_slug_uq ON workspaces (org_id, slug);
CREATE INDEX        workspaces_org_idx     ON workspaces (org_id, name);

-- ---------------------------------------------------------------------------
-- Memberships
-- ---------------------------------------------------------------------------
CREATE TABLE org_memberships (
  id         text        PRIMARY KEY,
  org_id     text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT org_memberships_role CHECK (role IN ('owner','admin','billing_admin','member'))
);

CREATE UNIQUE INDEX org_memberships_org_user_uq ON org_memberships (org_id, user_id);
CREATE INDEX        org_memberships_user_idx    ON org_memberships (user_id);

CREATE TABLE workspace_memberships (
  id           text        PRIMARY KEY,
  org_id       text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workspace_memberships_role
    CHECK (role IN ('workspace_admin','developer','analyst','viewer'))
);

CREATE UNIQUE INDEX workspace_memberships_ws_user_uq ON workspace_memberships (workspace_id, user_id);
CREATE INDEX        workspace_memberships_user_idx   ON workspace_memberships (user_id);
CREATE INDEX        workspace_memberships_org_idx    ON workspace_memberships (org_id);

-- ---------------------------------------------------------------------------
-- invitations — token HASH only, same reasoning as api_keys.
-- ---------------------------------------------------------------------------
CREATE TABLE invitations (
  id                  text        PRIMARY KEY,
  org_id              text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        text        REFERENCES workspaces(id) ON DELETE CASCADE,
  email               text        NOT NULL,
  org_role            text        NOT NULL,
  workspace_role      text,
  token_hash          text        NOT NULL,
  invited_by_user_id  text        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status              text        NOT NULL DEFAULT 'pending',
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  accepted_by_user_id text        REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invitations_status CHECK (status IN ('pending','accepted','revoked','expired')),
  CONSTRAINT invitations_org_role CHECK (org_role IN ('owner','admin','billing_admin','member')),
  CONSTRAINT invitations_ws_role CHECK (
    workspace_role IS NULL
    OR workspace_role IN ('workspace_admin','developer','analyst','viewer')
  )
);

CREATE UNIQUE INDEX invitations_token_hash_uq  ON invitations (token_hash);
CREATE INDEX        invitations_org_email_idx  ON invitations (org_id, lower(email));
-- One outstanding invite per (org, email).
CREATE UNIQUE INDEX invitations_pending_uq ON invitations (org_id, lower(email))
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- api_keys — workspace-scoped (docs/10 rule 4). HASH + PREFIX ONLY.
--
-- The plaintext secret is generated by newApiKeySecret(), shown to the user
-- exactly once in the creation response, and never persisted anywhere. There is
-- no column it could be recovered from and no code path that could reveal it.
-- Authentication: split the presented secret -> probe api_keys_prefix_uq ->
-- constant-time compare key_hash. That single index probe is the entire reason
-- `prefix` is stored separately.
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id                  text        PRIMARY KEY,
  org_id              text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                text        NOT NULL,
  mode                text        NOT NULL,
  prefix              text        NOT NULL,
  key_hash            text        NOT NULL,
  created_by_user_id  text        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  last_used_at        timestamptz,
  expires_at          timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT api_keys_id_prefix CHECK (id LIKE 'key\_%'),
  CONSTRAINT api_keys_mode CHECK (mode IN ('test','live')),
  -- The mode in the prefix must match the mode column, so a leaked key is
  -- instantly and correctly classifiable from its visible portion alone.
  CONSTRAINT api_keys_prefix_matches_mode CHECK (prefix LIKE 'key\_' || mode || '\_%'),
  -- Cheap structural guarantee that nobody ever stored a plaintext secret here:
  -- a sha256 hex digest is exactly 64 lowercase hex characters; a real secret
  -- (`key_live_` + 32 chars) is not.
  CONSTRAINT api_keys_hash_is_sha256 CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

-- The authentication path.
CREATE UNIQUE INDEX api_keys_prefix_uq ON api_keys (prefix);
CREATE UNIQUE INDEX api_keys_hash_uq   ON api_keys (key_hash);
CREATE INDEX api_keys_workspace_idx ON api_keys (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- agents
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
  id           text        PRIMARY KEY,
  org_id       text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  status       text        NOT NULL,
  version      integer     NOT NULL DEFAULT 1,
  description  text        NOT NULL DEFAULT '',
  language     text        NOT NULL DEFAULT 'en-US',
  prompt       text        NOT NULL,
  voice        jsonb       NOT NULL,
  pipeline     jsonb       NOT NULL,
  tools        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  stats        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agents_id_prefix CHECK (id LIKE 'agt\_%'),
  CONSTRAINT agents_status CHECK (status IN ('draft','live','paused','archived')),
  CONSTRAINT agents_version_positive CHECK (version >= 1),
  CONSTRAINT agents_prompt_len CHECK (char_length(prompt) BETWEEN 1 AND 100000),
  CONSTRAINT agents_tools_is_array CHECK (jsonb_typeof(tools) = 'array')
);

-- The agent list screen: workspace, most-recently-edited first.
CREATE INDEX agents_ws_updated_idx ON agents (workspace_id, updated_at DESC);
CREATE INDEX agents_org_idx        ON agents (org_id);
-- Search-by-name on the same screen.
CREATE INDEX agents_ws_name_idx    ON agents (workspace_id, lower(name));

-- ---------------------------------------------------------------------------
-- agent_versions — immutable published snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_versions (
  id                  text        PRIMARY KEY,
  org_id              text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id            text        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version             integer     NOT NULL,
  prompt              text        NOT NULL,
  language            text        NOT NULL,
  voice               jsonb       NOT NULL,
  pipeline            jsonb       NOT NULL,
  tools               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  change_note         text,
  published_by_user_id text       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_versions_version_positive CHECK (version >= 1)
);

CREATE UNIQUE INDEX agent_versions_agent_version_uq ON agent_versions (agent_id, version);
CREATE INDEX        agent_versions_ws_idx           ON agent_versions (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- phone_numbers
-- ---------------------------------------------------------------------------
CREATE TABLE phone_numbers (
  id                    text        PRIMARY KEY,
  org_id                text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id          text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  e164                  text        NOT NULL,
  country               char(2)     NOT NULL,
  provider              text        NOT NULL,
  attestation           text        NOT NULL DEFAULT 'none',
  reputation_score      integer,
  reputation_checked_at timestamptz,
  assigned_agent_id     text        REFERENCES agents(id) ON DELETE SET NULL,
  status                text        NOT NULL DEFAULT 'pending',
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT phone_numbers_id_prefix CHECK (id LIKE 'pn\_%'),
  CONSTRAINT phone_numbers_e164_fmt  CHECK (e164 ~ '^\+\d{6,15}$'),
  CONSTRAINT phone_numbers_attestation CHECK (attestation IN ('A','B','C','none')),
  CONSTRAINT phone_numbers_status CHECK (status IN ('active','pending','released')),
  CONSTRAINT phone_numbers_reputation_range
    CHECK (reputation_score IS NULL OR reputation_score BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX phone_numbers_e164_uq ON phone_numbers (e164);
CREATE INDEX        phone_numbers_ws_idx  ON phone_numbers (workspace_id, status);

-- ---------------------------------------------------------------------------
-- campaigns / leads
-- ---------------------------------------------------------------------------
CREATE TABLE campaigns (
  id           text        PRIMARY KEY,
  org_id       text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     text        NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  name         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'draft',
  schedule     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaigns_id_prefix CHECK (id LIKE 'camp\_%'),
  CONSTRAINT campaigns_status CHECK (status IN ('draft','running','paused','completed','archived'))
);

CREATE INDEX campaigns_ws_updated_idx ON campaigns (workspace_id, updated_at DESC);

CREATE TABLE leads (
  id              text        PRIMARY KEY,
  org_id          text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id     text        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  external_ref    text,
  e164            text        NOT NULL,
  phone           jsonb,
  attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Proof of consent. In the US, under the FCC's AI-voice reading of the TCPA,
  -- this column is the difference between a business and a class action (docs/13 §3).
  consent         jsonb,
  attempts        integer     NOT NULL DEFAULT 0,
  status          text        NOT NULL DEFAULT 'pending',
  last_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT leads_id_prefix CHECK (id LIKE 'lead\_%'),
  CONSTRAINT leads_e164_fmt  CHECK (e164 ~ '^\+\d{6,15}$'),
  CONSTRAINT leads_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT leads_status CHECK (
    status IN ('pending','in_progress','contacted','exhausted','suppressed')
  )
);

CREATE INDEX leads_campaign_status_idx ON leads (campaign_id, status);
CREATE INDEX leads_ws_idx              ON leads (workspace_id, created_at DESC);
CREATE INDEX leads_e164_idx            ON leads (workspace_id, e164);

-- ---------------------------------------------------------------------------
-- calls — the high-volume, retention-governed table.
--
-- purge_after is written at INSERT as started_at + workspace retention. Storing
-- the deadline on the row rather than recomputing it from workspaces on every
-- sweep means the sweep is one indexed range scan, and it means a customer who
-- shortens their retention policy does not retroactively change the deadline on
-- data already collected under the old one (which is the correct GDPR posture:
-- shortening applies going forward, and existing rows are re-stamped explicitly
-- by a documented backfill, not silently).
-- ---------------------------------------------------------------------------
CREATE TABLE calls (
  id                  text        PRIMARY KEY,
  org_id              text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id            text        NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_version_id    text        REFERENCES agent_versions(id) ON DELETE SET NULL,
  campaign_id         text        REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id             text        REFERENCES leads(id) ON DELETE SET NULL,
  phone_number_id     text        REFERENCES phone_numbers(id) ON DELETE SET NULL,
  direction           text        NOT NULL,
  mode                text        NOT NULL DEFAULT 'test',
  region              text        NOT NULL,
  status              text        NOT NULL,
  disposition         text,
  from_e164           text,
  to_e164             text,
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  duration_sec        integer,
  cost_usd            numeric(12,6),
  recording_url       text,
  recording_deleted_at timestamptz,
  pii_redacted        boolean     NOT NULL DEFAULT false,
  consent             jsonb,
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  purge_after         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT calls_id_prefix CHECK (id LIKE 'call\_%'),
  CONSTRAINT calls_direction CHECK (direction IN ('inbound','outbound')),
  CONSTRAINT calls_mode CHECK (mode IN ('test','live')),
  CONSTRAINT calls_region CHECK (region IN ('us-east','us-west','eu-west','eu-central')),
  CONSTRAINT calls_status CHECK (
    status IN ('queued','ringing','in_progress','completed','failed','no_answer')
  ),
  CONSTRAINT calls_duration_nonneg CHECK (duration_sec IS NULL OR duration_sec >= 0),
  CONSTRAINT calls_ended_after_started CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- THE two read patterns that matter. Both DESC, because every screen reads
-- newest-first and a DESC index lets Postgres skip the sort entirely.
CREATE INDEX calls_ws_started_idx       ON calls (workspace_id, started_at DESC);
CREATE INDEX calls_ws_agent_started_idx ON calls (workspace_id, agent_id, started_at DESC);
-- Org-wide roll-ups (billing, reseller reporting across child workspaces).
CREATE INDEX calls_org_started_idx      ON calls (org_id, started_at DESC);
-- The retention sweep. Partial: rows already purged have purge_after NULLed, so
-- the index shrinks as it does its job.
CREATE INDEX calls_purge_after_idx ON calls (purge_after)
  WHERE purge_after IS NOT NULL;
-- Recording deletion sweep — recordings often have a shorter life than metadata.
CREATE INDEX calls_recording_pending_idx ON calls (purge_after)
  WHERE recording_url IS NOT NULL AND recording_deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- turns
--
-- `text` is verbatim, `text_redacted` is PII-masked. Roles lacking call:read_pii
-- (analyst, viewer — src/domain/tenant.ts) are served the redacted column, which
-- is what makes it safe to give QA and BPO staff transcript access. Erasure NULLs
-- `text` and keeps `text_redacted`, so aggregate analytics survive a DSAR.
-- ---------------------------------------------------------------------------
CREATE TABLE turns (
  id            text        PRIMARY KEY,
  org_id        text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id  text        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  call_id       text        NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  seq           integer     NOT NULL,
  role          text        NOT NULL,
  text          text,
  text_redacted text,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  latency_ms    integer,
  tokens        integer,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT turns_id_prefix CHECK (id LIKE 'turn\_%'),
  CONSTRAINT turns_role CHECK (role IN ('agent','caller','system','tool')),
  CONSTRAINT turns_seq_nonneg CHECK (seq >= 0)
);

CREATE UNIQUE INDEX turns_call_seq_uq     ON turns (call_id, seq);
CREATE INDEX        turns_ws_started_idx  ON turns (workspace_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- audit_log — APPEND ONLY.
--
-- Sequential bigint, not a prefixed string: no API addresses an audit row by id,
-- and a gapless sequence makes tampering visible. The app role is granted INSERT
-- and SELECT and nothing else — see rls.sql §Grants.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id               bigserial   PRIMARY KEY,
  org_id           text        NOT NULL,
  workspace_id     text,
  actor_user_id    text,
  actor_api_key_id text,
  action           text        NOT NULL,
  target_kind      text        NOT NULL,
  target_id        text,
  ip               text,
  user_agent       text,
  before           jsonb,
  after            jsonb,
  at               timestamptz NOT NULL DEFAULT now()
);

-- Deliberately NO foreign keys on audit_log. An audit record must survive the
-- deletion of the thing it describes — that is most of the point of having one.
CREATE INDEX audit_log_org_at_idx   ON audit_log (org_id, at DESC);
CREATE INDEX audit_log_target_idx   ON audit_log (target_kind, target_id);
CREATE INDEX audit_log_actor_idx    ON audit_log (actor_user_id, at DESC);

-- ---------------------------------------------------------------------------
-- RLS enablement. Policies, roles, and grants are in rls.sql, applied next.
-- Enablement lives here so that a database created by migrations alone is never,
-- even briefly, an unpoliced one: with RLS enabled and no policy, the default is
-- deny-all for non-owner roles.
-- ---------------------------------------------------------------------------
ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces            ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_memberships       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys              ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents                ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_numbers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns             ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;

ALTER TABLE users                 FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations         FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces            FORCE ROW LEVEL SECURITY;
ALTER TABLE org_memberships       FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations           FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys              FORCE ROW LEVEL SECURITY;
ALTER TABLE agents                FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_versions        FORCE ROW LEVEL SECURITY;
ALTER TABLE phone_numbers         FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns             FORCE ROW LEVEL SECURITY;
ALTER TABLE leads                 FORCE ROW LEVEL SECURITY;
ALTER TABLE calls                 FORCE ROW LEVEL SECURITY;
ALTER TABLE turns                 FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log             FORCE ROW LEVEL SECURITY;

COMMIT;
