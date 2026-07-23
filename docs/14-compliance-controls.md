# Compliance by Design — SOC 2, GDPR, HIPAA

> ⚖️ **Not legal advice.** This maps requirements to engineering controls so the
> platform is *auditable by construction*. Every item needs review by counsel and,
> for SOC 2, by your auditor. Items marked ⚠️ are ones teams routinely get wrong.

Three regimes, three different shapes:

| | What it actually is | Who forces it | Effort split |
|---|---|---|---|
| **SOC 2 Type II** | Evidence that controls *operated* over 3–12 months | US enterprise procurement | ~70% process, 30% code |
| **GDPR** | Legal obligations on processing EU personal data | EU customers, regulators | ~50/50 |
| **HIPAA** | Safeguards for PHI + BAAs down the whole chain | US healthcare only | ~40% code, 60% contracts |

**The scheduling point:** SOC 2 Type II requires an *observation window*. You cannot
compress it. Start collecting evidence the day the platform has real users — it is a
calendar constraint, not an engineering one, and it gates US enterprise deals.

---

## 1. The voice-specific problems nobody plans for

These are the ones that bite this product category specifically.

### ⚠️ Voice recordings may be biometric data (GDPR Art. 9)

A voiceprint used to *identify or authenticate* a person is **special-category
biometric data** and needs an Art. 9 condition — not merely a lawful basis.

This matters directly, because `docs/03` §A specifies **target-speaker VAD**, which
enrolls a speaker embedding to distinguish the caller from background noise.

**Mitigations, which must hold or the feature becomes a legal problem:**
- The embedding is **ephemeral** — held in the media node's memory for the call's
  duration, never written to disk, never to a database
- It is used **only** to separate the caller from background audio, **never** to
  identify, authenticate, or match a person across calls
- No cross-call voiceprint store. If a customer ever wants voice authentication, that
  is a separate, opt-in product with explicit Art. 9 consent
- Documented in the Record of Processing as "acoustic source separation, non-identifying"

Get this wrong and a core quality feature becomes an Art. 9 violation.

### ⚠️ Transcripts and recordings are personal data by default

Everything a caller says is personal data, and in healthcare it is PHI. This means
retention limits, erasure rights, residency, and encryption apply to the *primary
product artefact*, not just to account records.

### ⚠️ The LLM prompt is a data transfer

Sending a transcript to a model vendor is disclosure to a sub-processor, in whatever
country it runs. This is why `docs/03` §E puts **PII redaction before the LLM**, not
just before storage — and why residency-aware provider selection exists.

### ⚠️ HIPAA constrains your vendor list, hard

Every sub-processor touching PHI needs a **BAA**. BAA availability from speech and
model vendors is uneven and often enterprise-tier only.

**Consequence:** HIPAA is *dramatically* easier with self-hosted inference. This
strengthens the owned-inference argument in `docs/01` §10 — it's not only margin, it's
market access.

**Recommendation:** treat HIPAA as **conditional and gated**. Do not claim it until
healthcare is a target segment and every link in the chain has a signed BAA.
A HIPAA-eligible workspace must be restricted to BAA-covered providers *in code*.

---

## 2. Control matrix

### SOC 2 (Trust Services Criteria)

| TSC | Control | Implementation | Where |
|---|---|---|---|
| CC6.1 | Logical access controls | Role→permission matrix, single authorization service, fail-closed | `domain/tenant.ts` |
| CC6.1 | Tenant isolation | Scope-first repositories (cross-tenant = compile error) + Postgres RLS | `repositories/`, `db/rls.sql` |
| CC6.2 | Registration/authorization of users | Invitation flow, verified email, role grants | `services/invitation-service.ts` |
| CC6.3 | Access removal | Membership revocation, API key revocation, session invalidation | `services/membership-service.ts` |
| CC6.6 | Encryption in transit | TLS 1.3 everywhere; SRTP/DTLS for media | infra |
| CC6.7 | Encryption at rest | Envelope encryption, per-tenant DEKs | `compliance/encryption.ts` |
| CC7.2 | Monitoring & anomaly detection | Structured logs, OTel traces, circuit-breaker state | `core/patterns/circuit-breaker.ts` |
| CC7.3 | Incident response | Documented runbook, breach clock | ops |
| **CC7.2** | **Audit logging** | **Append-only audit log; every auth + mutation + PII access** | `compliance/audit-log.ts` |
| CC8.1 | Change management | Immutable agent versions, PR review, deploy records | `services/agent-service.ts` |
| A1.2 | Availability | Cells, circuit breakers, fallback ladders | `docs/01` §7 |
| C1.1 | Confidentiality | Retention policy + hard delete | `compliance/retention.ts` |
| P4.2 | Retention & disposal | Per-workspace `retentionDays`, sweep job | `compliance/retention.ts` |

### GDPR

| Article | Requirement | Implementation | Where |
|---|---|---|---|
| Art. 5(1)(c) | Data minimisation | PII redaction before LLM and before storage | `compliance/pii.ts` |
| Art. 5(1)(e) | Storage limitation | Per-workspace retention, enforced sweep | `compliance/retention.ts` |
| Art. 6 | Lawful basis | Customer is controller; we record their basis per workspace | `ComplianceProfile` |
| **Art. 9** | **Special category** | **Ephemeral, non-identifying speaker embeddings only** | see §1 |
| Art. 12–14 | Transparency | AI disclosure at call start | `ComplianceProfile.aiDisclosureText` |
| Art. 15 | Right of access | DSAR export, all artefacts for a data subject | `compliance/data-subject-rights.ts` |
| Art. 16 | Rectification | Update APIs + audit trail | services |
| **Art. 17** | **Right to erasure** | **Hard delete across DB, recordings, traces, backups (documented)** | `compliance/data-subject-rights.ts` |
| Art. 20 | Portability | Machine-readable export (JSON + audio) | `compliance/data-subject-rights.ts` |
| Art. 25 | Data protection by design | This document; redaction on by default | platform |
| Art. 28 | Processor obligations | DPA, documented sub-processors, instruction-only processing | legal + `SUBPROCESSORS.md` |
| Art. 30 | Records of processing | Generated from the processing register | `compliance/audit-log.ts` |
| Art. 32 | Security of processing | Encryption, access control, testing | `compliance/encryption.ts` |
| Art. 33 | Breach notification | **72-hour clock** — detection + notification runbook | ops |
| Art. 44+ | International transfers | Residency pinning; EU data stays in EU cells | `services/region.ts` |

### HIPAA (conditional — only if selling healthcare)

| Safeguard | Requirement | Implementation |
|---|---|---|
| §164.312(a)(1) | Access control, unique user ID | `domain/tenant.ts`, per-user principals |
| §164.312(a)(2)(iv) | Encryption/decryption | Per-tenant DEK envelope encryption |
| §164.312(b) | **Audit controls** | Append-only audit log incl. **every PHI read** |
| §164.312(c)(1) | Integrity | Hash-chained audit entries |
| §164.312(d) | Person/entity authentication | Session + API key auth, timing-safe |
| §164.312(e)(1) | Transmission security | TLS 1.3, SRTP |
| §164.308(a)(4) | Minimum necessary | `call:read_pii` separated from `call:read` |
| §164.308(b)(1) | **BAAs with sub-processors** | **Provider allowlist enforced in code per workspace** |
| §164.530(j) | 6-year documentation retention | Audit log retained independently of call retention |

---

## 3. What this changes in the build

1. **Audit logging becomes mandatory, not optional.** SOC 2 CC7.2 and HIPAA
   §164.312(b) both require it, and HIPAA requires logging **reads** of PHI, not just
   writes. `call:read_pii` accesses must be logged individually.
2. **The audit log is append-only and hash-chained.** No UPDATE or DELETE grant for
   the application role. Tamper-evidence is the point.
3. **Audit retention is independent of call retention.** Calls may be purged at 90
   days; audit entries persist far longer (HIPAA: 6 years).
4. **A HIPAA-eligible workspace restricts providers to a BAA allowlist, in code.**
   Not a policy document — an enforced constraint, same mechanism as residency blocs.
5. **PII redaction runs before the LLM**, not only before storage.
6. **Erasure must reach recordings and traces**, not just database rows — including a
   documented backup-expiry story, since you cannot surgically delete from backups.
7. **Every provider needs a documented data-processing posture**: where it runs, what
   it retains, whether a BAA/DPA exists. This becomes `SUBPROCESSORS.md`, which
   customers *will* ask for during procurement.

---

## 4. Dashboard implications (for the frontend session)

- **PII masking is enforced server-side**, but the UI must show it honestly: masked
  spans render as `••••` with a tooltip "Hidden — requires call:read_pii".
- **Audit log viewer** — filterable by actor, action, resource, time. Auditors will
  ask for this, and it's a genuine enterprise selling point.
- **DSAR console** — search a data subject by phone/email, preview what would be
  exported or erased, then execute with confirmation.
- **Consent + disclosure settings** per workspace, with the disclosure text preview
  in each language.
- **Retention settings** with a plain-language explanation of what gets deleted when.
- **Never render PII in a URL, a page title, or an analytics event.**

---

## 5. Honest scoping

**Do now (Phase 1):** audit log, PII redaction, encryption envelope, retention
enforcement, access control, residency pinning, AI disclosure, `SUBPROCESSORS.md`.
These are cheap now and expensive to retrofit.

**Do next (Phase 2):** DSAR/erasure APIs, DPA template, ISO 27001 groundwork, start
the SOC 2 observation window.

**Do only if healthcare is a real target:** HIPAA. It constrains your vendor list,
requires BAAs you may not be able to get at your stage, and adds ongoing audit
burden. **Do not claim HIPAA readiness before every link has a signed BAA** — that
is a misrepresentation with real liability, and enterprise security reviews check.

The realistic sequence: **GDPR-grade engineering from day one** (it's the strictest
of the three on data handling and makes the others easier), **SOC 2 evidence
collection starting immediately**, **HIPAA only when a healthcare deal justifies it.**
