# Tenancy, Hierarchy & Onboarding

The platform is multi-tenant from the database up. Every resource in the system hangs off an
Organization, and almost everything operational hangs off a Project inside it — the same shape
GCP, Stripe, and Vercel use, for the same reasons.

```
User  ──(membership)──►  Organization
                              │  billing account, legal entity, compliance posture,
                              │  domain, audit log, org-level roles
                              │
                              ├──► Project  (dev / staging / prod, or per business unit)
                              │       │  data residency region, API keys, quotas,
                              │       │  project-level roles, retention policy
                              │       │
                              │       ├──► Agent ──► AgentVersion (immutable)
                              │       │              ├─ prompt, voice, pipeline config
                              │       │              ├─ tools
                              │       │              └─ flow graph
                              │       ├──► PhoneNumber
                              │       ├──► Campaign ──► Lead
                              │       ├──► Call ──► Turn ──► TraceEvent
                              │       ├──► KnowledgeBase
                              │       └──► ApiKey
                              │
                              └──► Project (another)
```

## Why a Project layer at all

It would be simpler to hang agents directly off the Organization. Three reasons not to:

1. **Environments.** Customers need `dev` / `staging` / `prod` with separate phone numbers, API
   keys, and quotas. Without projects they end up prefixing agent names with `TEST_` and
   eventually a test agent calls a real customer.
2. **Data residency.** Region is a **project** property. An EU project's calls, recordings, and
   transcripts pin to EU cells and never egress (docs/01-architecture.md §6, cell model). One
   org can legitimately operate in several regions; that's impossible if region is an org
   property.
3. **Blast radius and access control.** A contractor gets `viewer` on one project, not the whole
   company. An API key leak is scoped to one project's numbers and spend.

---

## Identifiers

Prefixed, opaque, non-sequential — readable in logs, safe in URLs, no information leaked about
volume.

| Entity | Prefix | Example |
|---|---|---|
| User | `usr_` | `usr_8k2mfq4x1p` |
| Organization | `org_` | `org_3nv9wz7t` |
| Project | `proj_` | `proj_qr52hd8m` |
| Agent | `agt_` | `agt_x71bkp39` |
| Agent version | `agv_` | `agv_5m2wq8dr` |
| Call | `call_` | `call_p93xzn4k` |
| Phone number | `pn_` | `pn_44kd82ms` |
| Campaign | `camp_` | `camp_7wq3nx1v` |
| API key | `key_` | `key_live_...` / `key_test_...` |
| Invitation | `inv_` | `inv_2bnq7wxc` |
| Membership | `mem_` | `mem_9zk4p1td` |

Slugs (`acme-corp`, `production`) are human-facing and unique **within their parent scope** —
`org.slug` globally unique, `project.slug` unique per org. URLs read
`/orgs/acme-corp/projects/production/agents/agt_x71bkp39`.

---

## Roles & permissions

Two levels, because access needs differ. Org roles grant baseline access across all projects;
project roles grant or narrow access to one.

### Organization roles

| Role | Manage org | Billing | Create projects | All-project access | Invite members |
|---|---|---|---|---|---|
| `owner` | ✅ | ✅ | ✅ | ✅ admin | ✅ |
| `admin` | ✅ | ❌ | ✅ | ✅ admin | ✅ |
| `billing_admin` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `member` | ❌ | ❌ | ❌ | only where explicitly added | ❌ |

At least one `owner` must exist at all times — the last one cannot be removed or demoted.

### Project roles

| Role | Edit agents | Publish to live | Place test calls | View traces | View PII | Manage numbers/keys |
|---|---|---|---|---|---|---|
| `project_admin` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `developer` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `analyst` | ❌ | ❌ | ❌ | ✅ | ❌ **redacted** | ❌ |
| `viewer` | ❌ | ❌ | ❌ | ✅ | ❌ **redacted** | ❌ |

`analyst`/`viewer` see transcripts with PII masked — this is what makes it safe to give QA and
BPO staff access to call traces (docs/03-problem-coverage.md 7.1).

Permissions are checked as `(userId, orgId, projectId, action)` in a single authorization
service. Never scattered across route handlers.

---

## Signup & onboarding flow

> **Revised** after benchmarking — see `docs/11-saas-benchmarks.md`. The earlier version of
> this section used a GCP-style "fill four forms before you see the product" wizard. It has
> been replaced with deferred, just-in-time collection. The hierarchy below is unchanged; only
> *when* we ask for each field has changed.

**Design goal: under 60 seconds from signup to talking to an agent.**

```
1. Sign up            email + password, or Google / Microsoft SSO
2. Verify email       6-digit code (not a magic link — works when signup and inbox
                      are on different devices)
3. → STRAIGHT TO A CONVERSATION
        auto-provisioned, no forms:
          org      "<Name>'s Organization", or the company name inferred from a
                   corporate email domain
          project  "Production", region inferred from IP
          agent    a working sample agent, in TEST mode
        first screen: "Talk to your agent" — browser mic, live latency readout
```

The org and project exist from second one; the user simply never filled a form for them.

### Just-in-time collection

Everything else is asked for at the moment it's actually needed — when the reason is obvious
and the user is motivated:

| Field | Collected when | Why then |
|---|---|---|
| First name, family name, phone | First team invite, or first live call | Needed for team display and account recovery |
| Org legal name, address, tax ID | Adding a payment method | It's for the invoice — self-evidently necessary at that moment |
| Billing email | Adding a payment method | Same |
| Industry, size | Dismissible profile card, never a blocker | This is for our sales team, not the user. Don't tax onboarding with it. |
| **Region confirmation** | Before the first **live** call | The one decision worth interrupting for |

**Region is inferred, then locked on first use** — not chosen blind in a wizard. It stays
editable while the project holds no real call data, and locks at the first live call with an
explicit confirmation. Asking someone to make a permanent data-residency decision in step 5 of
a signup flow, before they know what the product does, is a design error.

### Domain-based org discovery

Signing up with `@acme.com` when a **verified** `acme.com` organization already exists offers
*"Join Acme?"* with a request-to-join flow, rather than silently creating a duplicate org.
Domain claims require DNS TXT verification. This is the difference between one Acme account and
five Acme accounts with split billing.

### Test / live mode

A Stripe-style mode toggle in the header, per project, colour-coded and persistent:

- **Test** — browser and test numbers only, no PSTN spend, wipeable data, `key_test_…` keys
- **Live** — real telephony, real spend, `key_live_…` keys

This is both a developer-experience feature and a safety feature: it makes it structurally
impossible for a test agent to dial a real person (problem 5.4).

### Progressive disclosure

A solo user never sees the word "project". The project switcher appears when a second project
or a second member exists. The full hierarchy is in the data model from day one — it just
stays out of the way until it earns its place.

`OnboardingState` still tracks progress so any interrupted flow is resumable across devices.

### Fields collected

**User**
| Field | Notes |
|---|---|
| `email` | unique, verified; the login identity |
| `firstName`, `familyName` | separate fields — never a single "full name" |
| `phone` | `{ countryCode: 'IN', dialCode: '+91', number: '9876543210' }`, stored E.164 |
| `jobTitle` | optional, used for onboarding personalisation |
| `timezone`, `locale` | IANA tz + BCP-47; defaults detected from browser, user-editable |
| `avatarUrl` | optional |

**Organization**
| Field | Notes |
|---|---|
| `name` | display name |
| `legalName` | for invoices and contracts |
| `slug` | globally unique, URL segment |
| `website`, `industry`, `size` | size as a band: `1-10`, `11-50`, `51-200`, `201-1000`, `1000+` |
| `country` | ISO 3166-1 alpha-2 — drives tax, compliance defaults, dial-code default |
| `address` | `line1`, `line2`, `city`, `state`, `postalCode`, `country` — structured, never freeform |
| `phone` | country-code aware, same shape as user |
| `taxId` | GSTIN in India, VAT in EU, EIN in US — label follows the country |
| `billingEmail` | may differ from the owner's email |
| `timezone`, `currency` | defaults derived from country |

Why separate `name` and `legalName`: the invoice must say "Acme Technologies Private Limited"
while the UI says "Acme". Collecting only one forces an awkward migration later.

**Project**
| Field | Notes |
|---|---|
| `name`, `slug` | slug unique within the org |
| `environment` | `development` \| `staging` \| `production` |
| `region` | `us-east` \| `eu-west` \| `ap-south` … — **immutable after creation** |
| `retentionDays` | recording/transcript retention; bounded by the org's compliance tier |
| `piiRedaction` | on by default |

---

## Scoping rules — the ones that must not be broken

1. **Every query is scoped.** Repository methods take a `TenantContext { orgId, projectId }` as
   a required first argument. There is no `findAll()` without a scope — enforced by the
   repository interfaces, not by convention.
2. **Row-level enforcement.** Postgres RLS policies on `org_id` as a second line of defence, so
   an ORM mistake can't leak across tenants.
3. **The URL carries the scope.** `/orgs/:orgSlug/projects/:projectSlug/...` — no hidden
   "current project" in a session cookie that can desync from what the user is looking at.
4. **API keys are project-scoped**, never org-scoped. A leaked key exposes one project.
5. **Cross-project references are forbidden.** An agent in project A can never reference a phone
   number or knowledge base in project B.

---

## Region & residency

Project region maps directly to the cell model in docs/01-architecture.md §6. A project pinned
to `eu-west` has its calls routed only to EU cells, and its recordings, transcripts, and trace
events stored only in EU. The control plane is global; the **data plane is regional**.

This is why region is chosen at project creation and is immutable — changing it means migrating
every call record, recording, and trace, which is a support operation, not a settings toggle.

---

## What this changes in the build

- `Agent`, `Call`, `PhoneNumber`, `Campaign` all gain `orgId` + `projectId`.
- Every repository takes `TenantContext`.
- The dashboard gains an **org switcher** and a **project switcher** in the header.
- Routes become `/orgs/[orgSlug]/projects/[projectSlug]/...`.
- New screens: signup, email verification, onboarding wizard (4 steps), org settings, members
  & invitations, project settings, API keys, billing.
- An `AuthorizationService` checking `(user, org, project, action)` sits in front of every
  mutating route.
