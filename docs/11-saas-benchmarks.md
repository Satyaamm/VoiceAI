# How Other SaaS Platforms Model Hierarchy & Onboarding

Benchmarks for `docs/10-tenancy-and-onboarding.md`. Based on the published product designs of
these platforms as of early 2026 — worth re-verifying specifics before copying anything
closely, since onboarding flows change often.

---

## The landscape

| Platform | Hierarchy | Onboarding | What they get right | What they get wrong |
|---|---|---|---|---|
| **GCP** | Org → Folder → Project → Resource (4 levels) | Slow (~15 min to first resource) | Inherited IAM at every level; project is a real billing/quota boundary | Folders are overkill for 99% of customers; new users are lost before they ship anything |
| **AWS** | Org → OU → Account | Very slow | Hard account isolation | Account-per-environment is heavyweight; IAM is famously hard to reason about |
| **Stripe** | Account (+ Sandboxes) | Fast, and you can explore before completing setup | **Test/live mode toggle** — the single best idea in developer SaaS. Prefixed IDs. Restricted keys. | Historically no project layer, so multi-product companies improvised with multiple accounts |
| **OpenAI Platform** | Organization → Projects | Fast | Projects own their own API keys, members, **and rate limits** — very close to what we need | Project layer arrived late; existing users had to migrate |
| **Anthropic Console** | Organization → Workspaces | Fast | Workspaces carry **spend limits** and scoped keys — cost control as a first-class boundary | Fewer knobs than GCP-style IAM (deliberate) |
| **Supabase** | Organization → Projects | Fast | Clean 2-level model; **region chosen per project** — closest analogue to ours | Region immutable with limited warning; a known user complaint |
| **Vercel** | Personal / Team → Projects | **~60s to deployed** | **Deferred org creation** — you get value before any team setup | Personal→Team migration is awkward once you've built things |
| **Linear** | Workspace → Teams → Projects | ~2 min, best-in-class polish | Onboarding that *teaches* while it collects; keyboard-first from second one | Teams vs Projects confuses new users |
| **Auth0** | Tenant → Applications | Medium | Tenant is region-pinned — same residency shape as our Project | "Tenant" is jargon; users don't know how many to make |
| **Twilio** | Account → Subaccounts | Medium | Subaccounts give per-customer isolation for platforms | Effectively flat; no environment concept; verbose console |
| **Slack / Notion** | Workspace (Enterprise Grid: Org → Workspaces) | Very fast | **Email-domain auto-join** — the best land-and-expand mechanic in SaaS | Grid only exists at enterprise tier, so the model changes under you |
| **GitHub** | Org → Repos, Teams for permissions | Fast | Teams as a permission grouping scales to thousands of people | Permissions are repo-centric and get fiddly |
| **Vapi / Retell** | Org → flat list of agents | Fast | Nothing to learn | **No project layer at all** — no environments, no residency, no scoped keys. Customers prefix agents with `TEST_` and eventually a test agent calls a real customer. |

---

## The ten lessons

### 1. Two levels, not four
GCP's Org → Folder → Project → Resource serves enterprises with thousands of projects. Everyone
else drowns in it. Supabase, OpenAI, and Anthropic all landed on **Org → Project/Workspace**,
and that's the right depth. **We keep two.** If a customer ever needs folders, that's a very
good problem to have later.

### 2. Test/live mode beats a "staging project" — do both
Stripe's mode toggle is the most-copied idea in developer SaaS because it works: same
dashboard, same objects, no context switching, and it is *impossible* to accidentally hit
production. Separate projects for dev/staging still matter for teams that want separate
members and quotas — but the common case is one project with a mode toggle.

**For us:** test mode = browser calls and test numbers only, no PSTN charges, synthetic
telephony, freely wipeable data. `key_test_…` and `key_live_…` prefixes. This is *also* a real
safety feature — problem 5.4 in `docs/03-problem-coverage.md` is an agent calling a human it
shouldn't have.

### 3. Deferred organisation creation
Vercel gets you deployed in ~60 seconds because it never asks about your team first. GCP asks
for a billing account before you can do anything, and loses people.

**Our biggest onboarding fix:** do not ask for legal name, tax ID, and postal address before
the user has heard the product talk. Collect them **when they add a payment method or go
live** — the moment they're actually needed and the user is motivated.

### 4. Never ask what you can infer
Country from IP · timezone and locale from the browser · dial code from country · currency
from country · organisation name guessed from the email domain (`@acme.com` → "Acme") · tax-ID
label from country. Every inferred field is one less form row, and the user corrects the rare
miss.

### 5. Email-domain org discovery
Slack, Notion, and Linear all do this and it's the strongest land-and-expand mechanic in B2B
SaaS: the second person from `@acme.com` is *offered the existing org* instead of silently
creating a duplicate. Without it you end up with five "Acme" orgs, split billing, and a
support ticket. Requires domain verification (DNS TXT) before auto-join is offered.

### 6. Time to first value is the metric
Vercel ~60s to a deployed site. Linear ~2min to a first issue. GCP ~15min to anything.

**Our target: under 60 seconds from signup to talking to an agent in the browser.** No org
form, no project setup, no phone number purchase. A sample agent is pre-provisioned and the
"Talk to it" button is the first thing on screen. Everything else in onboarding can wait, and
most of it should.

### 7. Let people try before signing up
Vapi does this well — a demo agent you can talk to on the marketing site. For a voice product
this is unusually powerful, because the product **is** an experience: 20 seconds of a genuinely
fast agent does more than any landing-page copy. Capture the session and offer to save it when
they sign up.

### 8. Prefixed, opaque IDs
Stripe's `cus_`, `sub_`, `pi_` are readable in logs, safe in URLs, and leak nothing about
volume. Already adopted in `docs/10`.

### 9. Show the secret exactly once — and mean it
Every good platform does this; many do it with a dismissible toast that users lose. Make it a
modal that requires an explicit "I've saved it" action, with copy and download buttons.

### 10. Don't block on billing
Free trial credits so the first real call happens before any card is entered. Voice has genuine
marginal cost, so cap it — but the cap should be generous enough that evaluation never stalls.

---

## Where the voice-AI incumbents are weak

This is the part worth exploiting. Vapi, Retell, Bland, and Bolna all ship an **org with a flat
list of agents**. That means no environment separation, no data residency boundary, no
project-scoped API keys, no per-environment quotas, and no way to give a contractor access to
one workstream.

For an SMB buying self-serve, nobody notices. For the enterprise deals — banks, healthcare,
BPOs, insurers, exactly the buyers with the volume — it's disqualifying, and it's the kind of
thing that gets found in a security review after months of sales effort.

**Shipping a proper Org → Project model with regional pinning and scoped keys is a
differentiator against every one of them**, and it's far cheaper to build now than to retrofit.
OpenAI had to migrate every existing user to add projects; that migration is exactly what we're
avoiding.

---

## Revised design

Changes to `docs/10-tenancy-and-onboarding.md`, adopting the lessons above:

### A. Signup collects almost nothing

```
1. Sign up            email + password, or Google / Microsoft SSO
2. Verify email       6-digit code
3. → STRAIGHT TO A CONVERSATION
      auto-provision:  org  "<Name>'s Organization"  (from email domain if corporate)
                       project "Production", region inferred from IP
                       a sample agent, in TEST mode
      first screen:    "Talk to your agent" — big button, browser mic, live latency readout
```

**Under 60 seconds to hearing it work.** The org and project exist, but the user never filled
a form for them.

### B. Everything else is collected just-in-time

| We ask for… | …at this moment | Why then |
|---|---|---|
| First/family name, phone | First invite, or first live call | Needed for team display and account recovery |
| Org legal name, address, tax ID | Adding a payment method | Required for the invoice — user is motivated, and it's obviously why |
| Billing email | Adding a payment method | Same |
| Industry, size | Never as a blocker — a dismissible profile card | It's for our sales team, not the user's benefit. Don't tax onboarding with it. |
| Region confirmation | Before the first **live** call | The one decision worth interrupting for |

**This directly fixes a flaw in my own first draft:** I had region chosen at step 5 of a wizard
by a user who has no idea what it means yet, and made it permanently immutable. Instead:
infer it, and let it stay changeable **until the project holds real call data** — then lock it,
with an explicit confirmation at the moment of the first live call.

### C. Progressive disclosure of the hierarchy

A solo user never sees the word "project". The switcher appears only when a second project or
a second member exists. The machinery is there from day one in the data model — it just isn't
in anyone's face until it earns its place.

### D. Test/live mode toggle in the header

Prominent, colour-coded, persisted per project. Test mode: browser + test numbers only, no PSTN
spend, wipeable data, `key_test_` keys.

### E. Domain-based org discovery

Signing up with `@acme.com` when a verified `acme.com` org exists → *"Join Acme?"* with a
request-to-join flow, instead of creating a duplicate. Requires DNS TXT verification before the
org can claim a domain.

---

## Scorecard

| Dimension | GCP | Stripe | Vercel | Vapi | **Us** |
|---|---|---|---|---|---|
| Time to first value | ~15 min | ~3 min | ~60 s | ~5 min | **< 60 s** |
| Hierarchy depth | 4 | 1 | 2 | 1 | **2** |
| Test/live mode | ❌ | ✅ | ❌ | ❌ | **✅** |
| Data residency per project | ✅ | ❌ | ❌ | ❌ | **✅** |
| Scoped API keys | ✅ | ✅ | ✅ | ❌ | **✅** |
| Domain auto-join | ❌ | ❌ | ✅ | ❌ | **✅** |
| Deferred org details | ❌ | ✅ | ✅ | ✅ | **✅** |
| Try before signup | ❌ | ❌ | ❌ | ✅ | **✅** |

The bet: **GCP's rigour with Vercel's onboarding.** Enterprise-grade tenancy underneath, and a
solo developer never has to see it to get a call working in a minute.
