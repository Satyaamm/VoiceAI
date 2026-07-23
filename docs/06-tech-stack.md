# Tech Stack

## Languages — three, with clear boundaries

| Language | Where | Why it and not something else |
|---|---|---|
| **Rust** | Media node, turn orchestrator (Phase 2), audio DSP, endpointer runtime | You have a **10ms deadline every 10ms, forever**. A 50ms GC pause is an audible glitch on 1,000 concurrent calls. Rust has no GC, no runtime pauses, and predictable memory. This is the one place the language choice is non-negotiable. |
| **Python** | All ML (training, serving glue), Phase 1 orchestrator | Every model tool you need — PyTorch, NeMo, vLLM, ONNX export, the LiveKit Agents SDK — is Python-first. Fighting that costs months and buys nothing. |
| **TypeScript** | Control plane API, dashboard, customer SDKs, Temporal workers | One language across API + web + SDK. Control plane is CRUD and workflow glue — it is IO-bound and latency-insensitive, so "boring and fast to write" beats "fast at runtime." |

**Go** is the reasonable alternative for the control plane, and worth it if you end up patching
LiveKit (which is Go) or pushing the dialer past ~2k CPS. Don't add it on day one — three
languages is already the ceiling for a small team.

### The rule
> **Rust above the audio frame. Python where the models are. TypeScript everywhere latency doesn't matter.**

### Roads not taken
- **Node for media** — GC pauses, same problem as Java, plus worse audio libraries.
- **C++** — would work, but Rust gives you the same performance with memory safety on a codebase where a buffer bug is a dropped call. No reason to pick C++ for new code here.
- **Elixir/Erlang** — genuinely great for telephony (this is what it was built for) and the actor model maps beautifully to per-call processes. Rejected on ML ecosystem and hiring, not on merit. If you had an Elixir team, it'd be defensible for the orchestrator.
- **Go for the hot path** — GC is much better than Java's, but it's still GC. Fine for LiveKit's SFU (packet forwarding tolerates jitter); not fine for a 10ms DSP loop.

---

## Full stack by layer

### Hot path — Rust

| Concern | Choice |
|---|---|
| Async runtime | `tokio` (+ `tokio-uring` / `monoio` for io_uring on the packet path) |
| RTP / SRTP | `webrtc-rs` crates, or hand-rolled — RTP itself is simple |
| Echo cancellation | `webrtc-audio-processing` bindings (AEC3) |
| Noise suppression | DeepFilterNet (ONNX) or `nnnoiseless` |
| VAD | Silero VAD via `ort` (ONNX Runtime) |
| Speaker embedding | ECAPA-TDNN via `ort` — for target-speaker VAD |
| Endpointer inference | `ort` + ONNX, quantized, CPU-resident |
| Codecs | `audiopus` (Opus); G.711 is a lookup table |
| IPC to inference | shared memory ring buffer + `io_uring`, never a socket |
| Serialization | `rkyv` or raw structs — zero-copy, no JSON on the hot path |

**Hard rules:** no allocation on the packet path (pre-allocated pools), no `.await` that can
block >1ms, one OS thread pinned per core, `jemalloc`/`mimalloc`.

### ML & inference — Python

| Concern | Choice |
|---|---|
| Runtime | Python 3.12, `uvloop` |
| LLM serving | **vLLM** → TensorRT-LLM at scale. Prefix caching is the requirement. |
| ASR | **NVIDIA NeMo — Parakeet-TDT** (streaming transducer). *Not* Whisper. |
| ASR serving | Triton Inference Server (dynamic batching, per-stream state) |
| TTS | Streaming AR model + fast vocoder on Triton |
| Endpointer training | PyTorch → ONNX export → consumed by Rust |
| Experiment tracking | Weights & Biases |
| Feature/eval store | Postgres + S3; ClickHouse for eval aggregates |

### Phase 1 orchestrator — Python

`livekit-agents` SDK, `asyncio` + `uvloop`, our own turn-detector and LLM node swapped in
progressively (see `ORCHESTRATION.md`). Replaced by Rust in Phase 2.

### Control plane — TypeScript

| Concern | Choice |
|---|---|
| Runtime | Node 22 (or Bun if you like living slightly ahead) |
| API | **Hono** or Fastify — REST + WebSocket |
| Schema/validation | Zod, shared with the SDK for free types |
| DB | **Postgres 16** — agents, tenants, numbers, campaigns, billing |
| ORM | Drizzle |
| Ephemeral call state | **Redis Cluster** — snapshots only, never source of truth mid-turn |
| Workflows | **Temporal** (TS SDK) — campaigns, retries, post-call |
| Events | **Redpanda** (Kafka API, lower ops cost) |
| Auth | Better-Auth or WorkOS (enterprise SSO/SCIM matters for this buyer) |

### Analytics & observability

| Concern | Choice |
|---|---|
| Call traces + analytics | **ClickHouse** — per-call waterfalls, latency percentiles, funnel queries. Postgres will not survive 100k calls/hour of span data. |
| Tracing | OpenTelemetry, custom span per pipeline stage |
| Metrics/alerts | Prometheus + Grafana |
| Logs | Loki, or ClickHouse to keep one system |
| Recordings/transcripts | S3 (or Cloudflare R2 — egress pricing matters at this volume) |

### Frontend

Next.js + React + TypeScript, Tailwind + shadcn/ui, TanStack Query.
Live call view over WebSocket. The **per-call waterfall trace viewer** (audio scrub + ASR
partials + LLM tokens + tool timings + barge-in markers) is the highest-value screen in the
product — it's what makes customers trust you when something goes wrong.

### Infrastructure

| Concern | Choice |
|---|---|
| CPU workloads | Kubernetes + Karpenter |
| **GPU** | **Bare metal** — CoreWeave / Crusoe / Lambda, or colo. Cloud GPU pricing at this scale destroys the margin thesis. |
| Media nodes | Bare metal or network-optimized instances, **host networking, no service mesh** — a sidecar proxy on the audio path is a self-inflicted 2–5ms |
| SIP trunking | Telnyx or Plivo → direct carrier interconnect later |
| IaC | Terraform (or Pulumi if you want it in TS) |
| CI/CD | GitHub Actions → ArgoCD |
| Secrets | Vault or cloud KMS; per-tenant keys for recordings |

**Deployment note:** media nodes are **drained, never restarted** with live calls on them.
Wire that into the deploy pipeline from day one, not after your first incident.

---

## Repo layout

```
voiceai/
├── media/              Rust — RTP, jitter, AEC, denoise, VAD, barge-in
├── orchestrator/       Rust (P2) — turn state machine
├── orchestrator-py/    Python (P1) — LiveKit Agents based
├── endpointer/         Python — training; exports ONNX to media/
├── inference/          Python — vLLM/Triton configs, model servers
├── flow-engine/        TypeScript — dialogue state graph interpreter
├── control-plane/      TypeScript — API, Temporal workers, dialer
├── dashboard/          TypeScript — Next.js
├── sdk/                TypeScript + Python client SDKs
├── proto/              Shared schemas (protobuf/Zod)
└── infra/              Terraform, k8s, Helm
```

---

## Hiring implication

Worth stating plainly, because it constrains the plan more than any technical choice:

- **Rust + audio DSP + telephony** is the scarce skill set. One or two of these people gate the
  entire Phase 2 latency story. Start recruiting before you need them.
- **Python/ML** — plentiful. Speech-specific (streaming ASR, TTS) is harder than generic ML.
- **TypeScript** — plentiful.

If you can't hire the Rust/audio person, the honest fallback is: stay on LiveKit + Python
longer, accept ~500–600ms instead of 320ms, and compete on the layers from
`PROBLEM-COVERAGE.md` (entity capture, guardrails, eval harness) instead of on raw latency.
That's still a viable product — the incumbents are beatable on reliability alone. It's just a
different wedge, and you should choose it deliberately rather than drift into it.
