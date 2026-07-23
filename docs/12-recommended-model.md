# What's Actually Right for the Voice AI Industry

`docs/11-saas-benchmarks.md` looked at how generic SaaS models hierarchy. This document is a
recommendation, not a survey — because copying Vercel or GCP would be a mistake here. Voice AI
differs from ordinary SaaS in five ways that should change the design.

---

## Why voice AI is not ordinary SaaS

**1. Every call has real marginal cost.** Telephony minutes plus GPU seconds. There is no
free-forever tier, and an agent stuck in a loop burns actual money in real time. Cost control
cannot be a billing-page afterthought; it belongs in the resource hierarchy.

**2. Mistakes reach real humans, with legal consequences.** A misconfigured agent doesn't
render a broken page — it *phones someone*, possibly at 2am, possibly on a DNC list, possibly
in a jurisdiction requiring AI disclosure. The blast radius is regulatory. That makes this
closer to Stripe (moving money) than Vercel (deploying sites).

**3. The buyer is frequently not a developer.** Vapi and Retell are developer-first products.
The volume — and the revenue — sits in contact centers, BPOs, insurers, banks, collections
agencies. Those buyers do not have "projects". They have **brands, lines of business, clients,
and campaigns**.

**4. Agencies and BPOs are a first-class segment, especially in India.** A BPO runs campaigns
for 20 different end-clients and needs per-client isolation, per-client billing, per-client
data separation, and often per-client logins. This is Twilio's subaccount problem, and every
voice-AI incumbent handles it badly or not at all.

**5. Phone numbers are scarce, regulated, reputation-bearing assets.** They're tied to regions,
carriers, and attestation status. They aren't fungible config — they're inventory with a
lifecycle.

---

## My recommendation

### 1. Two levels: **Organization → Workspace**. Not "Project".

Keep the depth at two — that part of the benchmark holds. But **name the second level
`Workspace`, and define it as a business boundary, not an environment**:

> A Workspace is a **brand, business unit, or end-client**. Everything a workspace owns is
> isolated from every other workspace: agents, phone numbers, campaigns, calls, knowledge
> bases, API keys, spend, and compliance posture.

Why not "Project": it's developer jargon. A contact-center operations lead has never
created a project in their life, and the word actively misleads them into thinking it's a
temporary thing. "Workspace" reads correctly to both a developer and an ops manager — which
is exactly why Slack and Anthropic use it.

Why not environments as the second level: because **test/live mode handles that**, and burning
your one hierarchy level on dev/staging leaves you with nowhere to put the isolation that
actually matters.

### 2. Test/live mode, not staging workspaces

Stripe's model, per workspace, in the header. Test mode = browser and test numbers, synthetic
telephony, zero PSTN spend, wipeable data, `key_test_` keys.

This is a **safety control**, not just DX. It makes it structurally impossible for a test agent
to dial a real person — and "our test agent called a customer" is the kind of incident that
ends a pilot.

### 3. Spend caps as a first-class property of the Workspace

Not a billing setting. A hard resource limit, enforced by the Cost Governor
(`docs/03-problem-coverage.md` §L), configured per workspace:

- monthly cap, daily cap, per-call cap
- action on breach: degrade to a cheaper model → wrap up gracefully → hard stop
- live burn rate visible in the header, next to the mode toggle

Anthropic's workspace spend limits are the right model. For voice this matters more, because
a runaway loop costs telephony minutes on top of tokens — and because a BPO reselling your
platform *must* be able to cap each of its clients.

### 4. Compliance profile as a first-class property of the Workspace

This is genuinely unique to voice and no competitor has it:

- jurisdiction(s) and consent model (one-party / two-party recording)
- mandatory AI-disclosure text, per jurisdiction
- calling windows in the **callee's** local time
- DNC / DND registries to check (including India's TRAI DND)
- per-lead attempt caps, recording retention, PII redaction policy
- data residency region

Compliance varies by *who you're calling on behalf of*, not by company. A BPO calling for a
bank and for a retailer has two different compliance postures — which is precisely why this
belongs on the workspace, not the org.

### 5. Design for resellers now, even if you build it later

Add a nullable `parentOrgId` to Organization from day one. That single column is the difference
between supporting BPOs and white-label partners later, and a painful migration.

A BPO becomes a parent org whose child orgs are its clients: consolidated billing upward,
isolated data sideways, optional client logins with restricted roles, and their branding on the
dashboard. **This segment is large, underserved, and it's where Gnani and Bolna live.** The
incumbents' flat model cannot express it at all.

You do not need to build reseller UI in v1. You do need the column, and you need the
authorization service to be written in terms of an org *tree* rather than a flat org.

### 6. Keep Vercel's onboarding

Everything in `docs/11` §Revised design stands: 60 seconds to a live conversation,
auto-provisioned org and workspace, just-in-time collection of legal and billing detail,
region inferred and locked on first live use.

The hierarchy should be **invisible to a solo developer on day one and sufficient for a
500-seat BPO on day 400**. Progressive disclosure is what makes both true at once.

---

## The resulting model

```
Organization                      the legal entity — billing, contracts, SSO, audit
  ├─ parentOrgId?                 non-null for reseller/BPO child accounts
  ├─ Members                      org roles: owner / admin / billing_admin / member
  │
  └─ Workspace                    a brand, business unit, or end-client
       ├─ Mode: test | live       Stripe-style toggle
       ├─ Region                  data residency; inferred, locked on first live call
       ├─ Spend caps              monthly / daily / per-call + breach action
       ├─ Compliance profile      jurisdiction, consent, windows, DNC, disclosure, retention
       ├─ Members                 workspace roles: admin / developer / analyst / viewer
       ├─ API keys                key_live_… / key_test_…
       │
       ├─ Agents ─► AgentVersion (immutable) ─► prompt, voice, pipeline, tools, flow
       ├─ PhoneNumbers            with reputation + attestation status
       ├─ Campaigns ─► Leads
       ├─ Calls ─► Turns ─► TraceEvents
       └─ KnowledgeBases
```

Two levels. Nothing deeper. If a customer ever genuinely needs folders, that's a very good
problem to have in year three.

---

## What I'd fight hardest for

If you take only three things from this document:

1. **Workspace = business boundary, with spend caps and compliance profile attached.**
   This is the design that maps to how the actual buyers are organised, and it's the one
   the incumbents cannot retrofit cheaply.

2. **Test/live mode from day one.** Cheap to build now, and it prevents the single most
   embarrassing category of incident in this industry.

3. **`parentOrgId` from day one.** One nullable column. It's the difference between owning
   the BPO/agency segment and being locked out of it.

Everything else — the onboarding polish, the switcher UX, the role matrix — is refinable
later. These three are structural, and retrofitting any of them means migrating live customer
data.

---

## Beyond hierarchy: what wins this industry

Since the question was "what's best for this industry", the honest answer extends past tenancy.
Ranked by how much they actually decide deals:

1. **Reliability of the conversation, not raw latency.** Latency gets you the demo. What loses
   the renewal is the agent mishearing an order number, stopping mid-sentence because a dog
   barked, or hallucinating a refund policy. `docs/03-problem-coverage.md` §A and §B are worth
   more than the last 100ms.
2. **Being able to prove a change is safe.** The eval/simulation harness. No competitor can
   answer "will this prompt change break my agent?" and every serious customer eventually asks.
3. **Owned inference.** 3× margin, no vendor outage exposure, no rate limits. It funds
   everything else and it's the hardest thing for a thin-wrapper competitor to copy.
4. **Compliance that's real, not a checkbox.** In regulated verticals this is the gate, and
   most of the category is nowhere near it.
5. **Latency.** Genuinely important, and the best demo asset you have — but it's fourth, not
   first, once you're past the pilot.
