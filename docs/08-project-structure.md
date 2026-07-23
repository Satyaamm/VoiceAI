# Project Structure & Language Boundaries

> "in backend what language are we using — Rust, Go, Python?"

**All three, plus TypeScript.** "Backend" here is not one service — it's four, split by
latency requirement. The language follows the deadline, not preference.

```
VoiceAI/
├── docs/                    ← all design docs (this folder)
├── backend/
│   ├── control-plane/       TypeScript   API, agents, campaigns, billing
│   ├── orchestrator/        Python → Rust   the turn loop
│   ├── media/               Rust         RTP, VAD, AEC, barge-in
│   └── inference/           Python       ASR / LLM / TTS serving
└── frontend/                TypeScript   Next.js + Ant Design dashboard
```

---

## Why each one

| Service | Language | Latency budget | Why this language |
|---|---|---|---|
| `media/` | **Rust** | **10ms, hard** | A deadline every 10ms forever. A 50ms GC pause is an audible glitch across every call on the node. No GC, no runtime pauses, predictable memory. Non-negotiable. |
| `orchestrator/` | **Python** (P1) → **Rust** (P2) | 10–50ms | P1: LiveKit Agents is Python, and vendor APIs already cost 400–600ms so Python's jitter is noise. P2: once we self-host and chase 320ms, that jitter becomes the budget. Planned rewrite behind a stable interface. |
| `inference/` | **Python** | 50–200ms | PyTorch, NeMo, vLLM, Triton, ONNX export are all Python-first. GPU time dominates; interpreter overhead is irrelevant here. |
| `control-plane/` | **TypeScript** | seconds | CRUD + workflow glue. IO-bound, latency-insensitive. Shares Zod schemas with the frontend, so API types can't drift from the client. |
| `frontend/` | **TypeScript** | — | Next.js + Ant Design. |

### The rule
> **Rust where there's an audio deadline. Python where the models are. TypeScript where latency doesn't matter.**

### Why not Go anywhere?

It's the obvious candidate for `control-plane/`, and it's a fine choice. We didn't take it
because sharing Zod schemas between the API and the dashboard eliminates a whole class of
type-drift bugs, and a fourth language is real overhead for a small team.

**Revisit Go if:** the dialer needs to push past ~2k CPS, or you end up patching LiveKit
(which is Go). Neither is a Phase 1 problem.

Go is explicitly *not* an option for `media/` — its GC is far better than the JVM's, but it's
still a GC, and a 10ms DSP loop can't absorb a pause.

---

## What's built where

### `backend/control-plane/` — TypeScript (building now)

The service the dashboard talks to. Owns agents, versions, phone numbers, campaigns, call
records, billing, and webhook delivery. Also the **composition root**: the registries and
factories that decide which STT/LLM/TTS/strategy implementations a given agent uses.

```
control-plane/src/
├── core/patterns/       Registry, Factory, Strategy, Chain, CircuitBreaker, EventBus, DI
├── domain/              Agent, Call, Turn entities + Zod schemas (shared with frontend)
├── providers/           Adapters: Deepgram, OpenAI, Anthropic, Cartesia, ElevenLabs
├── orchestration/       Turn state machine + guardrail chain (reference impl / simulator)
├── repositories/        Data access interfaces + in-memory and Postgres impls
├── api/                 Hono routes
└── container.ts         Composition root — wires every registry
```

The turn state machine lives here in a **reference implementation** used by the simulator and
the eval harness. The production hot-path version is `orchestrator/`. Same state machine,
same strategy interfaces, different runtime — which is what lets the eval harness test
strategy changes without spinning up media infrastructure.

### `backend/orchestrator/` — Python, then Rust

The live turn loop. Phase 1 is LiveKit Agents with our turn detector and LLM node swapped in
(docs/05-orchestration.md). Phase 2 is a Rust rewrite consuming audio frames over shared
memory from `media/`.

### `backend/media/` — Rust

RTP/SRTP, jitter buffer, AEC, denoise, VAD, target-speaker gating, barge-in detection, DTMF,
recording tap. Phase 2 — Phase 1 uses LiveKit's Go media plane.

### `backend/inference/` — Python

vLLM for the LLM (prefix caching by `agent_id`), Triton for Parakeet ASR and streaming TTS,
plus the endpointer training pipeline that exports ONNX for `media/` to consume.

---

## How they talk

```
frontend ──HTTP/WS──► control-plane ──Temporal──► campaigns/dialer
                            │
                            │ agent config (cached in-cell)
                            ▼
carrier ──SIP──► media ──shared memory──► orchestrator ──gRPC (same rack)──► inference
                   ▲                            │
                   └────── audio out ───────────┘
                                                │
                                          events (fire-and-forget)
                                                ▼
                                      Redpanda ──► ClickHouse / S3 / webhooks
```

**The rule that matters:** `control-plane` is never on the call path. It configures calls and
consumes their results. If it goes down entirely, live calls continue and new calls route
from each cell's cached agent config — degraded, not dead (docs/01-architecture.md §7).

---

## Build order

| Phase | What exists | Language |
|---|---|---|
| **Now** | `control-plane` + `frontend` — full API and dashboard against a simulated pipeline | TypeScript |
| **P1** | `orchestrator` on LiveKit Agents + vendor APIs; real calls | + Python |
| **P2** | `inference` self-hosted; `media` + `orchestrator` rewritten | + Rust |

Building `control-plane` and `frontend` first is deliberate: the turn state machine, strategy
interfaces, and event schema get designed and exercised in the fastest language to iterate in,
against a simulator. By the time the Rust rewrite happens, the design is settled and the
rewrite is mechanical rather than exploratory.
