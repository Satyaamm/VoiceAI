# API Design & Versioning

## Layout

```
src/api/
├── index.ts              app factory — assembly order, mounting
├── middleware/
│   └── index.ts          tenantContext, errorHandler, versionHeader
├── v1/
│   ├── index.ts          the v1 router
│   ├── session.ts        GET /v1/session
│   ├── workspaces.ts     /v1/org, /v1/workspaces
│   ├── agents.ts         /v1/agents
│   └── platform.ts       /v1/capabilities, /audit, /compliance, /providers
└── routes/               modules using register(app, container) with absolute paths
    ├── auth.ts           /auth/*  — UNauthenticated
    ├── calls.ts          /v1/calls
    └── telephony.ts      /v1/numbers, /v1/campaigns
```

**Middleware lives outside the version folder.** Authentication, error mapping, and
request context are platform concerns, not API-version concerns. When v2 arrives it
reuses them unchanged — only the *route surface* is versioned, not the application.

Adding v2 is then: create `src/api/v2/`, mount it beside v1, done. Both share the
same services and middleware; v1 keeps working.

## Assembly order

Order in `createServer()` is load-bearing:

1. CORS + error handler + version header — apply to everything, including 401s
2. `GET /health` — unversioned; liveness must not depend on the API surface or auth
3. `/auth/*` — **unauthenticated by definition**; this is where sessions are created
4. `tenantContext` on `/v1/*` — everything past here is authorized
5. v1 routes

Swapping 3 and 4 would make signup require a session.

## Conventions

| | |
|---|---|
| **Versioning** | URL path (`/v1/...`). Explicit, cacheable, trivially routable at the edge. Not headers. |
| **Version header** | Every response carries `x-api-version` so clients can detect drift. |
| **Tenancy** | `x-workspace-id` header selects the workspace; `x-mode: test\|live` selects mode. **Absence of mode means `test`** — a forgotten header must never place a real billable call. |
| **Auth** | `Authorization: Bearer <session>` or an API key (`key_live_…` / `key_test_…`). One resolver handles both. |
| **Errors** | Handlers throw domain errors; middleware maps them. A handler that builds an error response is a bug. |
| **Not-found vs forbidden** | Cross-tenant access returns **404, not 403** — never confirm a resource exists to someone outside its tenant. |
| **Validation** | Zod at the boundary. Write DTOs are narrower than read models: ids, versions, stats, and tenancy are server-assigned. |
| **Pagination** | `?page=&pageSize=&search=`, response `{ items, total, page, pageSize }`. |

## Error shape

```json
{ "error": "validation_failed",
  "issues": [{ "path": "compliance.retentionDays", "message": "..." }] }
```

| Code | Status |
|---|---|
| `unauthenticated` | 401 |
| `forbidden` (+ `required` permission) | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `validation_failed` (+ `issues`) | 400 |
| `internal_error` | 500 — message never leaked, logged server-side |

## Route surface (v1)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | Auto-provisions org + workspace + sample agent; returns a session |
| POST | `/auth/login`, `/auth/verify-email`, `/auth/logout` | |
| GET | `/v1/session` | Everything the shell needs in one call |
| GET/PATCH | `/v1/org` | |
| GET/POST | `/v1/workspaces` | |
| GET/PATCH | `/v1/workspaces/:id` | Region immutable once locked |
| GET/POST | `/v1/agents` | Workspace-scoped |
| GET/PATCH/DELETE | `/v1/agents/:id` | Delete is a soft archive — calls reference it |
| POST | `/v1/agents/:id/publish` | Snapshots an immutable version |
| GET | `/v1/agents/:id/versions` | |
| POST | `/v1/agents/:id/rollback/:version` | Restores config; never rewrites history |
| GET | `/v1/calls`, `/v1/calls/:id`, `/v1/calls/:id/trace` | PII masked without `call:read_pii` |
| GET/POST/DELETE | `/v1/numbers`, `/v1/campaigns` | |
| GET | `/v1/capabilities` | Registry-driven **+ per-workspace eligibility** |
| GET | `/v1/providers/health` | Circuit-breaker states |
| GET | `/v1/audit`, `/v1/audit/verify` | Chain integrity proof |
| GET | `/v1/compliance/subprocessors` | Procurement artefact |

## Two decisions worth calling out

**`/v1/capabilities` returns ineligible providers too, with a reason.** An EU-pinned
workspace can't select a US-only vendor and a HIPAA workspace can't select a non-BAA
one — but silently omitting the option makes *"why can't I pick Deepgram?"*
unanswerable in the UI. We return `eligibility[]` with machine-readable reason codes
so the frontend can disable-with-explanation.

**Capabilities are registry-driven.** Registering a provider or strategy makes it
appear in the dashboard with no frontend change. That is the payoff for the Registry
pattern in `core/patterns/registry.ts`.

## Deprecation policy (for when v2 exists)

1. v2 ships alongside v1; nothing is removed on day one.
2. v1 responses gain `x-api-deprecation: <sunset-date>`.
3. Minimum 12 months of overlap for paying customers.
4. Never break v1 in place — additive changes only. A field may be added; a field may
   never change type or disappear.
