# VoiceAI

A low-latency AI voice agent platform. Target: **sub-400ms response latency** at
**100,000 concurrent calls**.

The thesis: most platforms in this category are glue layers, brokering
telephony → STT → LLM → TTS across four vendors over the public internet. Every hop
is a TLS handshake and a cross-region round trip, which floors turn latency around
800ms–1.4s and stacks four margins. This owns the media path and co-locates the
models.

> **Status: early.** The control plane, tenancy, compliance layer and turn
> orchestrator run end-to-end against a simulator. The Rust media node and
> self-hosted inference are Phase 2. See [`docs/01`](docs/01-architecture.md) §11.

## Latency budget

Measured *user stops speaking* → *first agent audio*:

| Stage | Typical stack | Here |
|---|---|---|
| Endpointing decision | 300–700 ms | **60–120 ms** |
| STT finalization | 100–300 ms | **~0 ms** |
| LLM time-to-first-token | 300–600 ms | **90–180 ms** |
| TTS time-to-first-audio | 150–400 ms | **60–110 ms** |
| **p50 total** | **~1,100 ms** | **~370 ms** |

STT contributes ~0 because streaming transcription happens *during* the caller's
speech. The three overlaps that make this work are described in
[`docs/02-call-flow.md`](docs/02-call-flow.md).

## What's here

```
backend/
  control-plane/   TypeScript — API, tenancy, agents, compliance, orchestrator
  orchestrator/    Python → Rust — the live turn loop        (Phase 1 / 2)
  media/           Rust — RTP, VAD, AEC, barge-in            (Phase 2)
  inference/       Python — ASR / LLM / TTS serving          (Phase 2)
frontend/          Next.js + Ant Design dashboard
docs/              Architecture, market, compliance, API design
```

Language follows the deadline: **Rust where there's an audio deadline, Python where
the models are, TypeScript where latency doesn't matter.**
([`docs/08`](docs/08-project-structure.md))

## Run it

```bash
cd backend/control-plane && npm install && npm run dev   # :3101
cd frontend              && npm install && npm run dev   # :3100
```

```bash
curl -X POST localhost:3101/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@acme.de","password":"correct-horse-battery-staple","country":"DE"}'
```

Signup auto-provisions an organization, a workspace, and a working sample agent —
with German language, Frankfurt data residency, and two-party recording consent all
**derived from the country**, not configured. No forms.

## Design decisions worth knowing

- **Semantic endpointing, not a silence timer.** Commits at ~120ms on a complete
  utterance but waits ~570ms mid-ID, so it's simultaneously faster *and* less likely
  to cut you off. A fixed timer cannot do both. ([`docs/01`](docs/01-architecture.md) §4)
- **Speculative prefill.** LLM prefill starts before the caller finishes; discarded
  if they keep talking. ~8% wasted compute for 100–200ms of latency.
- **Barge-in truncates context to what was *played out*,** not what was generated —
  the bookkeeping bug behind "the agent forgot what it was saying."
- **Org → Workspace tenancy,** where a workspace is a business boundary (brand,
  business unit, end-client) carrying its own region, spend caps and compliance
  profile. ([`docs/12`](docs/12-recommended-model.md))
- **Compliance is enforced, not documented.** An EU-pinned workspace physically
  cannot select a US-only provider. ([`docs/14`](docs/14-compliance-controls.md))
- **Cross-tenant access is a compile error.** Repository methods take a scope as
  their first argument; there is no `findAll()`.

## Documentation

| | |
|---|---|
| [01 Architecture](docs/01-architecture.md) | Latency budget, topology, capacity model |
| [02 Call flow](docs/02-call-flow.md) | How a turn actually works |
| [03 Problem coverage](docs/03-problem-coverage.md) | ~65 failure modes → components |
| [08 Project structure](docs/08-project-structure.md) | Language boundaries |
| [12 Tenancy model](docs/12-recommended-model.md) | Org → Workspace |
| [14 Compliance](docs/14-compliance-controls.md) | SOC 2 / GDPR / HIPAA controls |
| [16 API design](docs/16-api-design.md) | Versioning and conventions |

## Contributing

`main` is protected — see [CONTRIBUTING.md](CONTRIBUTING.md). Changes land through a
reviewed pull request with CI green; direct pushes are rejected by the server.

## Disclaimer

`docs/` contains regulatory analysis written for engineering purposes. It is **not
legal advice**, and items marked ⚖️ are unresolved questions pending review by
counsel. Do not rely on it as a compliance guarantee.
