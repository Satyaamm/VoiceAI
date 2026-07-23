# Build vs. Buy — What Sits Between the Components

> "what are we using in between — Pipecat or something else?"

## The one-line answer

**Buy the media transport. Build the pipeline.**

Pipecat inverts that — it gives you the pipeline (opinionated) and leaves media transport to a
plugin. But the pipeline *is* the moat (endpointing, barge-in, speculative prefill), and media
transport is the 6-month commodity you don't want to write. So Pipecat is backwards for this
specific product.

**Recommended: LiveKit (media + SIP) + our own orchestrator.**

---

## The candidates

### Pipecat (Daily)
Python, asyncio, frame-based pipeline. `Transport → STT → LLM → TTS → Transport` as composable
processors.

| ✅ | ❌ |
|---|---|
| Fastest path to a working demo — days, not weeks | **Python on a 10ms audio deadline.** GIL + GC + asyncio scheduling adds 5–30ms of *jitter*, and jitter is worse than latency |
| Huge library of service integrations already written | Opinionated pipeline — you'd fight it to add speculative prefill and playout-accurate barge-in truncation |
| Good interruption handling out of the box | Typically **one process per call**; ~100–200MB each. 100k calls is not a tuning problem, it's an architecture mismatch |
| Transport-agnostic (Daily, LiveKit, Twilio, WS) | No media plane of its own — you still need to solve SIP/RTP separately |

**Verdict:** excellent prototyping tool. Not a platform foundation. Its pipeline is precisely
the layer we intend to differentiate on, so adopting it means either accepting their latency
floor or forking it.

### LiveKit + LiveKit Agents
Go-based SFU (genuinely production-grade, real scale), `livekit-sip` for PSTN, agents framework
in Python/Node.

| ✅ | ❌ |
|---|---|
| **Media plane is Go, not Python** — this is the part that must not have GC pauses, and theirs is battle-tested | Agents layer is still Python (but we're replacing that anyway) |
| SIP ingress/egress built in — saves months | SFU is designed for multi-party; we're 1:1, so we carry some unused complexity |
| Self-hostable — no vendor lock, no per-minute tax | Another distributed system to operate |
| Handles ICE/NAT/TURN/codec negotiation, which is miserable to write | |

**Verdict:** buy this for Phase 1–2. It replaces exactly the layer we don't want to build, and
leaves the layer we do want to build untouched.

### Vocode
Similar shape to Pipecat, smaller ecosystem, less momentum. No reason to pick it over Pipecat.

### Build everything (Rust from day one)
Correct end state. Wrong starting point — you'd spend 4 months on SIP and NAT traversal before
you could demo anything, and SIP is a genuinely nasty spec with 25 years of carrier quirks.

---

## Layer-by-layer decision

| Layer | Phase 1 | Phase 2–3 | Why |
|---|---|---|---|
| PSTN trunking | **Buy** — Telnyx / Plivo (better SIP + margins than Twilio) | Direct carrier interconnect | Carrier relationships are a business problem, not a code problem |
| SIP signaling / SBC | **Buy** — LiveKit SIP (or Kamailio) | Kamailio + own media core | Never hand-write SIP. Ever. |
| WebRTC transport | **Buy** — LiveKit | Keep, or Pion-based custom | ICE/NAT/DTLS is thankless commodity work |
| **RTP audio processing** — VAD, AEC, denoise, target-speaker, barge-in | **BUILD** (Python/Rust hybrid) | **BUILD** — Rust | 🔒 **This is the moat.** Sub-30ms barge-in is why we win |
| **Turn orchestrator / state machine** | **BUILD** — Python is fine here initially | **BUILD** — Rust | 🔒 **Moat.** Speculative prefill + playout-accurate context truncation |
| **Semantic endpointer** | **BUILD** — small model | **BUILD** | 🔒 **Biggest moat.** Worth 300–500ms of p50 |
| STT | Buy — Deepgram / AssemblyAI | **Self-host** Parakeet-TDT | Vendor for speed, self-host for margin + control |
| LLM | Buy — Claude / GPT | **Self-host** 8–30B + vLLM | Prefix caching needs to be ours |
| TTS | Buy — Cartesia (lowest TTFB) / ElevenLabs | **Self-host** streaming AR | Biggest per-minute cost line |
| Model serving | **Buy** — vLLM / TensorRT-LLM / Triton | Same | Do not write an inference server |
| Text normalization + lexicon | **BUILD** | **BUILD** | Nobody does this well; cheap to build |
| Guardrails / grounding | **BUILD** | **BUILD** | Enterprise sign-off depends on it |
| Control plane, dashboards | **BUILD** — boring stack, Postgres | Same | Commodity, but must be ours |
| Eval / simulation harness | Defer | **BUILD** | 🔒 Moat — the thing that makes customers *stay* |

**The rule:** buy anything below the audio frame, build anything that touches conversation
timing or decisions.

---

## Concretely: Phase 1 stack

```
Telnyx SIP trunk
   ↓
LiveKit SIP + SFU            ← bought, self-hosted, Go
   ↓  (audio frames over LiveKit's track API)
OUR Orchestrator (Python)    ← built
   ├─ Acoustic frontend      ← built (webrtc-apm/Silero bindings, or Rust ext)
   ├─ Endpointer             ← built (small model, ONNX)
   ├─ Deepgram streaming     ← bought
   ├─ Claude / GPT           ← bought
   ├─ Cartesia streaming     ← bought
   └─ Normalizer             ← built
   ↓
back out through LiveKit
```

Python is acceptable in Phase 1 **because vendor APIs already cost you 400–600ms** — Python's
10ms of jitter is noise against that. It stops being acceptable the moment you self-host and
are chasing a 320ms budget. That's the Phase 2 rewrite trigger, and it should be a *planned*
rewrite of a component with a stable interface, not a surprise.

## Phase 2 stack

```
Kamailio (signaling only)
   ↓
OUR Rust media node          ← built: RTP, jitter, AEC, denoise, VAD, barge-in
   ↓  (shared memory ring buffer — zero network hops)
OUR Rust orchestrator        ← built
   ├─ Parakeet on Triton     ← self-hosted, same rack
   ├─ vLLM w/ prefix cache   ← self-hosted, same rack
   └─ TTS on Triton          ← self-hosted, same rack
```

LiveKit stays for the WebRTC/browser path, where its NAT traversal keeps earning its place.

---

## Why not just use Pipecat and optimize later?

Because the three things that make this product work are things Pipecat's architecture actively
resists:

1. **Speculative prefill** requires firing the LLM on a *probability* from the endpointer and
   cancelling it — Pipecat's frame pipeline is designed around committed turns.
2. **Playout-accurate context truncation** on barge-in requires reading the RTP send counter
   from the media layer. Pipecat abstracts the transport away, so that number isn't reachable
   without going under the framework.
3. **Sub-30ms barge-in** requires the decision to happen in the media process. Pipecat makes it
   in Python, downstream of the transport.

You would end up forking it within two months. Better to take LiveKit for transport — which has
no opinion about any of the above — and own the pipeline from the start.

**Use Pipecat if:** you want a demo running this week to show an investor or validate a script.
It's genuinely the fastest way to do that. Just don't let that prototype become the product.

---

## Cost of the Phase 1 bought stack

Roughly, per minute of conversation:

| | ~$/min |
|---|---|
| Telnyx PSTN | 0.007 |
| Deepgram streaming STT | 0.006 |
| Claude/GPT (≈8 turns/min) | 0.020 |
| Cartesia TTS (~38% duty) | 0.030 |
| LiveKit self-hosted compute | 0.003 |
| **Total** | **~$0.066** |

Vapi charges ~$0.05 platform fee *on top of* roughly these same vendor costs. Self-hosting in
Phase 2 takes this to **$0.02–0.04** — that delta is the entire business.
