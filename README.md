<div align="center">

# VoiceAI

**An AI voice agent platform that sounds like a conversation, not software.**

Build phone and web agents that answer, understand, act on your systems, and hand
off to a human when they should.

[Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## Why

Voice agents mostly fail on the small things. They talk over you. They stop
mid-sentence because a dog barked. They mishear the order number you just read out
twice. They confidently invent a refund policy. Latency gets all the attention, but
what actually loses a customer is an agent that isn't *reliable* in conversation.

This platform is built around those failures.

## Features

### Natural conversation
- **Semantic turn-taking** — decides you've finished from your words *and* your
  intonation, not a silence stopwatch. It replies fast when you're clearly done and
  waits when you're mid-thought.
- **Interruption handling** — talk over the agent and it stops immediately, then
  remembers exactly how much you actually heard.
- **Noise-robust listening** — a TV, an open-plan office, or someone else in the room
  won't make the agent stop mid-sentence.
- **Backchannel awareness** — an "mhm" doesn't derail it.
- **No dead air** — a natural "let me check that" covers slow lookups.

### Understanding what people actually say
- **Reliable capture of order IDs, emails, postcodes and reference numbers** —
  slot-aware recognition with confidence-targeted confirm-back, so the agent asks
  about the one character it's unsure of instead of reading the whole thing back.
- **Accent and telephony robustness** on narrowband audio.
- **Your vocabulary** — product names, SKUs and place names biased into recognition.

### Speaking properly
- **22 locales** with honest quality tiers — English, German, French, Spanish,
  Italian, Dutch, Portuguese, Polish and more.
- **Formal / informal register** — du vs Sie, tu vs vous. Getting this wrong is rude
  in a way English has no equivalent for, and no TTS vendor handles it.
- **Correct pronunciation of numbers, money, dates, URLs and emails** per language.
  `10/03` is October 3rd in the US and 10 March in Europe; getting that wrong books
  the wrong appointment.
- **Pronunciation lexicon** — teach it how to say your brand and product names.

### Doing real work
- **Tools and integrations** — look up an order, book a slot, write to your CRM.
- **Guardrails** — grounded answers, no invented policies or prices, and it will
  always tell a caller it's an AI when asked.
- **Human handoff** with the full conversation summary carried across.
- **Deterministic flows** for the steps that must not improvise — payment,
  verification, booking.

### Telephony
- Inbound and outbound, voicemail detection, DTMF, warm transfer, call recording.
- **Compliance built in** — calling windows in the callee's local time, do-not-call
  screening, consent tracking, per-jurisdiction disclosure.

### For the team running it
- **Per-call trace** — every stage of every turn, time-aligned with the audio. When
  something goes wrong you can see precisely where.
- **Versioned agents** — publish, diff, roll back.
- **Workspaces** — separate brands, business units or clients, each with their own
  numbers, data region, spend caps and compliance settings.
- **Test mode** — talk to your agent in the browser without touching a real phone
  line or spending a cent.

---

## Getting started

```bash
# API
cd backend/control-plane && npm install && npm run dev    # :3101

# Dashboard
cd frontend && npm install && npm run dev                 # :3100
```

Create an account and you get a working agent immediately — no setup forms:

```bash
curl -X POST localhost:3101/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@acme.de","password":"a-good-passphrase","country":"DE"}'
```

That single call provisions your organization, a workspace, and a sample agent —
with the right language, data region and recording-consent rules **derived from your
country**. The response points straight at the agent to talk to.

## Project layout

```
backend/
  control-plane/   API, workspaces, agents, compliance, orchestration
  orchestrator/    the live conversation loop
  media/           audio: RTP, echo cancellation, voice activity, barge-in
  inference/       speech recognition, language model and speech synthesis serving
frontend/          dashboard
docs/              architecture
```

## Status

Early. The API, tenancy, compliance layer and conversation orchestrator run
end-to-end against a simulator. The real-time media path and self-hosted speech
models are in progress. Expect things to move.

## Contributing

`main` is protected — changes land through a reviewed pull request with CI passing.
See [CONTRIBUTING.md](CONTRIBUTING.md). Start from `develop`.

## Disclaimer

Documentation here is written for engineering purposes and is **not legal advice**.
Compliance features are tools to help you meet your obligations, not a guarantee that
you do.
