# UI Layer

Three distinct surfaces, three different sets of constraints:

1. **Dashboard** — the operator console (build, test, run, analyze agents)
2. **Embeddable widget** — the web-call button our customers drop on their own site
3. **Client SDKs** — what developers integrate with

The dashboard is not a commodity here. Competitors ship a prompt textbox and a call list; the
#1 operational complaint in `PROBLEM-COVERAGE.md` (6.2 — *"can't tell why a call failed"*) is a
**UI** problem, not a backend one. The trace viewer below is the single highest-value screen in
the product.

---

## Core stack

| Concern | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 (App Router) + React 19** | Server components for the heavy list/analytics pages, client islands for the realtime ones |
| Language | TypeScript, strict | Types shared with the API via Zod — one schema, no drift |
| Components | **Ant Design v5** (+ ProComponents) | Decided. Enterprise-density component set — see §Ant Design below |
| Layout | **antd `Layout` / `Flex` / `Space` / `Row`+`Col`** | antd already ships layout primitives. No Tailwind. |
| Custom styling | **`antd-style`** (`createStyles`) or CSS Modules | Token-aware CSS-in-JS. One source of truth for color/spacing — the antd theme. |
| Server state | **TanStack Query** | antd has no server-state story. Caching, background refetch, optimistic updates |
| Client state | **Zustand** | Small; Redux is overkill |
| Tables | **antd `ProTable`** (`virtual` for long lists) | Filters, column config, server pagination, export — all built in |
| Forms | **antd `ProForm`** + Zod for validation at the boundary | Agent config is a big nested form; ProForm handles it |
| Charts | **`@ant-design/plots`** for standard charts; **custom canvas** for the trace viewer | Consistent with antd's visual language; the trace viewer can't be a chart library |
| Flow editor | **React Flow (xyflow)** | The dialogue state graph editor — mature, don't build this |
| Code/prompt editor | **CodeMirror 6** | Lighter than Monaco, enough for prompts + JSON tool schemas |
| Audio waveform | **WaveSurfer.js** (canvas) or custom canvas | DOM rendering dies on a 10-minute call |
| In-browser calls | **LiveKit client SDK** | Same transport as production — test what you ship |
| Realtime updates | WebSocket → TanStack Query cache | One socket per session, multiplexed by topic |
| Auth | Better-Auth or WorkOS | Enterprise SSO/SCIM is table stakes for this buyer |

---

## Ant Design — setup, tradeoffs, and traps

**Why it fits:** this is a dense operational console — tables, filters, forms, trees, transfers,
date ranges, descriptions, drawers, nested config. Ant Design ships every one of those at
production quality, and **ProComponents** (`ProTable`, `ProForm`, `ProLayout`) collapses the
CRUD surface — agents, numbers, campaigns, tools, team, billing — into config rather than code.
For an enterprise buyer, antd's information density is a genuine advantage over the airier
component libraries.

### Setup traps — hit these before writing a screen

1. **React 19.** antd v5 officially targets React 16–18. Install
   `@ant-design/v5-patch-for-react-19` and apply it at the app entry, or `message`, `notification`,
   and `Modal.confirm` will silently fail. *Verify current compatibility before pinning — if it
   looks unsettled, run React 18 for the dashboard. It costs nothing here.*

2. **SSR with App Router.** Wrap the root layout in `AntdRegistry` from
   `@ant-design/nextjs-registry`, or antd's CSS-in-JS styles won't be extracted server-side and
   you get a flash of unstyled content on every load.

3. **No Tailwind, no shadcn in the dashboard.** Both are redundant once antd is the decision,
   and mixing them actively costs you (see §Why not Tailwind/shadcn below). antd's `Layout`,
   `Flex`, `Space`, and `Row`/`Col` cover layout; `antd-style`'s `createStyles` covers the
   custom cases with access to the same theme tokens.

4. **Bundle size.** antd + ProComponents is heavy. Fine for an authenticated dashboard behind a
   login. **Never** in the embeddable widget — that stays Preact/vanilla at <50KB. Keep the
   dependency boundary strict so nobody imports a `Button` into the widget "just this once."

5. **Theming.** All customization goes through `ConfigProvider` tokens:
   ```tsx
   <ConfigProvider theme={{
     algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
     token: { colorPrimary: '#...', borderRadius: 6, fontFamily: '...' },
     components: { Table: { cellPaddingBlockSM: 4 } },   // dense call logs
   }}>
   ```
   Dark mode is `theme.darkAlgorithm` — free, and operators watching live calls will want it.

### The honest tradeoff

Default antd looks like default antd — the visual signature of a thousand enterprise SaaS
products. That's a real cost for a company whose pitch is "we're the fast, modern one." Budget
a week of design-token work early: **type scale, primary color, border radius, table density,
and spacing rhythm.** Those five tokens do ~80% of the work of not looking generic, and doing
it up front is far cheaper than restyling 40 screens later.

### Why not Tailwind / shadcn

**shadcn/ui — drop entirely.** It's a component library built on Radix. antd is a component
library. Running two means two `Button`s, two `Modal`s, two focus-trap implementations, two
theming systems, and an endless per-PR argument about which one to import. Pick one. We picked
antd.

**Tailwind — drop from the dashboard.** The only argument left for it was layout utilities, and
antd already ships those:

| Instead of | Use |
|---|---|
| `flex gap-4 items-center` | `<Flex gap={16} align="center">` |
| `grid grid-cols-3 gap-4` | `<Row gutter={16}>` + `<Col span={8}>` |
| `space-y-4` | `<Space direction="vertical" size={16}>` |
| app shell / sider / header | `<Layout>` + `<Layout.Sider>` |
| `text-sm text-gray-500` | `<Typography.Text type="secondary">` |
| arbitrary custom styling | `createStyles(({ token }) => ...)` from `antd-style` |

Keeping Tailwind buys you a familiar syntax and costs you: the preflight-vs-antd reset conflict,
a second build step, two competing spacing scales, and — worst — **two sources of truth for
color**. The moment `bg-blue-500` and `token.colorPrimary` both exist in the codebase, dark
mode breaks in a hundred small places and rebranding becomes a multi-week project.

**Where Tailwind still earns its place** — packages that don't load antd at all:
- `widget/` — the embeddable web-call widget (<50KB budget, Preact, no antd)
- `marketing/` — the public site
- `docs/` — developer documentation

That's a clean boundary: **antd inside the product, Tailwind outside it.** They never meet in
the same bundle, so neither conflict ever arises.

### What antd does *not* replace

| Need | Still use |
|---|---|
| Dialogue state-graph editor | **React Flow (xyflow)** — no antd equivalent |
| Prompt / JSON schema editing | **CodeMirror 6** — antd's `Input.TextArea` is not an editor |
| Audio waveform + trace lanes | **Canvas / WaveSurfer** — must be custom |
| Server state & caching | **TanStack Query** |
| Browser voice calls | **LiveKit client SDK** |
| Realtime transport | Plain WebSocket |

---

## The screens

### Build
| Screen | Notes |
|---|---|
| **Agent editor** | Prompt (CodeMirror), voice, tools, knowledge, endpointing profile, guardrails. **Version history with diff + one-click rollback** — see 6.7 |
| **Flow editor** | React Flow graph of the dialogue state machine (§F). Nodes = states, edges = transitions with conditions. Business-critical paths get built here, not prompted |
| **Voice studio** | Voice picker with instant preview, speaking-rate/style controls, and the **pronunciation lexicon editor** (§D) — type a brand name, hear it, override the phonemes. Nobody offers this well |
| **Tools** | HTTP/function config, JSON schema editor, live test with a mock payload |
| **Knowledge** | Upload, index status, retrieval preview ("what would the agent retrieve for this query?") |

### Test
| Screen | Notes |
|---|---|
| **Test console** | Talk to the agent **in the browser** via the LiveKit client. Live transcript, live latency readout per turn, live state-machine position. This is the inner dev loop — make it fast |
| **Simulation runs** | Replay a corpus of real call audio + synthetic personas against a candidate version. Pass/fail per scenario, **diff vs. the current production version**. This is 6.1 — *"I changed the prompt and found out from a customer."* CI for agents |

### Run
| Screen | Notes |
|---|---|
| **Live calls** | Aggregate counters + a sampled live list. **At 100k concurrent you cannot stream every call to a browser** — server-side aggregation, drill down on demand |
| **Live call detail** | Listen in, watch the transcript stream, **barge in as a human** (takeover), or trigger transfer |
| **Campaigns** | Lead lists, pacing, compliance windows, live progress, per-lead attempt state |
| **Numbers** | Purchase, SIP trunks, **reputation/spam-flag status** per number (§I) |

### Analyze
| Screen | Notes |
|---|---|
| **Call log** | Virtualized, filterable by outcome/latency/agent version/duration/sentiment |
| **Call trace viewer** | ⭐ See below |
| **Analytics** | Latency percentiles by stage, success rate, containment, escalation rate, **cost per call**, funnel by flow state |

---

## ⭐ The call trace viewer

The screen that wins deals. When something goes wrong, every competitor gives you a transcript
and a recording. We give you the entire pipeline, time-aligned.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ▶ ━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━  02:14 / 05:32     │
├──────────────────────────────────────────────────────────────────────┤
│ Caller  ▁▃▅▇▅▃▁▁▁▁▁▁▁▁▃▅▇▇▅▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▃▅▇▅▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │
│ Agent   ▁▁▁▁▁▁▁▃▅▇▇▇▅▃▁▁▁▁▁▁▁▁▁▁▃▅▇▇▇▇▇█▓░╳ barge-in  ▁▁▃▅▇▅▃▁▁▁ │
├──────────────────────────────────────────────────────────────────────┤
│ VAD        ▓▓▓▓▓░░░░░░▓▓▓▓▓▓░░░░░░░░░░░▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░ │
│ Endpoint   ╱╲__╱▔╲___╱▔▔╲__ P(done) curve, commit points marked ●   │
│ ASR        │partial│partial│FINAL "check my order status"           │
│ LLM        ░░ prefill ░│▓▓▓▓ decode 340ms ▓▓▓▓│                     │
│ Tool       ─────────────│▓▓ get_order 890ms ▓▓│  ⚠ over p95         │
│ TTS        ──────────────────│▓▓▓ synth ▓▓▓│                        │
│ Guardrail  ─────────────────────│✓ grounded│                        │
├──────────────────────────────────────────────────────────────────────┤
│ TURN 4   end-of-speech → first audio:  412ms                        │
│   endpointing  94ms ██▊                                              │
│   LLM TTFT     88ms ██▍   (prefix cache HIT)                         │
│   TTS TTFB    112ms ███                                              │
│   network      58ms █▌                                               │
│   ▸ view exact LLM context sent (2,140 tok, 2,050 cached)           │
└──────────────────────────────────────────────────────────────────────┘
```

**Features:**
- Scrub the audio; every lane stays time-aligned
- Click any turn → exact LLM context sent, tokens in/out, tool request/response payloads,
  ASR n-best with confidences, guardrail decisions
- Barge-in markers show **what the caller actually heard** vs. what was generated (the 1.10 /
  §barge-in bookkeeping made visible — invaluable for debugging)
- Filter to "turns over 600ms" and jump straight to the outliers
- **Shareable link** for support tickets and customer escalations

**Implementation constraints:**
- A 10-minute call is ~30,000 events. **Canvas rendering, not DOM.** One canvas per lane,
  redraw on pan/zoom, virtualize by time window.
- Trace data lives in **ClickHouse**, fetched at the resolution the viewport needs (downsample
  server-side; never ship 30k points to draw 800 pixels).
- Audio streams as HLS/range requests from S3 — never load a whole WAV.
- Target: trace opens in **<800ms** for any call. If debugging is slow, people stop debugging.

---

## Embeddable web-call widget

What our customers drop on *their* site to take voice calls from visitors.

| Concern | Choice |
|---|---|
| Framework | **Preact** or vanilla TS — **not** React |
| Bundle budget | **<50KB gzipped** including the LiveKit client. Customers will reject a 300KB widget |
| Isolation | **Shadow DOM** — their CSS must not leak in, ours must not leak out |
| Delivery | Single `<script>` tag + a `data-agent-id` attribute; ESM module for bundler users |
| Transport | LiveKit client (WebRTC) |
| Mic UX | Explicit permission prompt, visible mute, live audio-level indicator, clear "agent is listening / speaking" state |
| Fallback | If WebRTC is blocked (corporate networks), offer a dial-in number |
| a11y | Keyboard operable, screen-reader announcements for state changes, captions toggle |
| Theming | CSS custom properties, light/dark, position/size config |

Ship a **captions view** by default. It doubles as accessibility and as trust — users can see
they were understood correctly, which meaningfully reduces the frustration from 2.1–2.5
(entity capture errors).

---

## Client SDKs

| SDK | Purpose |
|---|---|
| `@voiceai/web` | Browser WebRTC calls; the widget is a thin wrapper over this |
| `@voiceai/react` | Hooks: `useVoiceAgent()`, `useTranscript()`, `useAgentState()` |
| `@voiceai/node` | Server-side: create agents, dispatch calls, verify webhooks |
| `voiceai` (Python) | Same, for the ML/data-team buyer |
| React Native / Swift / Kotlin | Phase 3 — mobile matters for consumer apps |

Types generated from the same Zod schemas the API validates with. One source of truth, no drift.

---

## Design principles

1. **Latency is the product — show it everywhere.** A live per-turn latency readout on the test
   console and a p50/p95 badge on every agent. If you're 3× faster than Vapi, the UI should make
   that impossible to miss.
2. **Every number is a link.** "Success rate 87%" → click → the 13% that failed → click → traces.
   Never a dead-end metric.
3. **Optimize the inner loop.** Edit prompt → test call → see trace should be **under 10 seconds**.
   That loop's speed determines whether customers succeed with the product.
4. **Realtime where it matters, polled where it doesn't.** WebSocket for live calls and test
   console. Plain queries for logs and analytics. Don't stream what nobody's watching.
5. **Progressive disclosure.** A prompt-and-a-voice ships in 2 minutes. The flow graph,
   lexicon, and guardrails are there when the customer is ready — not in their face on day one.
