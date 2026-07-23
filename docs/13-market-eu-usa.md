# Market: Europe + USA

Target markets are **EU/UK and USA**. That changes the competitive set, makes compliance a
Phase 1 concern rather than Phase 3, opens a language wedge, and puts real pressure on the
self-hosting margin thesis in Europe.

> ⚠️ Regulatory specifics below are current to my knowledge as of early 2026 and are
> **directional, not legal advice**. Telecoms and AI regulation in both markets is moving fast.
> Every item marked ⚖️ needs verification with counsel before it drives a product decision.

---

## 1. The competitive set changes

Bolna and Gnani are India-focused — largely irrelevant here. The real competition splits in two:

### Developer-first platforms (US-origin)
**Vapi, Retell, Bland, Synthflow, ElevenLabs Agents.** These are the ones the original
architecture targets: thin orchestration over vendor APIs, 800ms–1.4s latency, English-first,
flat tenancy, weak compliance. Beatable exactly as `docs/01` and `docs/03` describe.

### Enterprise CX platforms (EU-origin, and serious)
**Parloa** (Germany, very well funded), **Cognigy** (Germany, acquired into the NiCE stack),
**PolyAI** (UK). These are a *different* kind of competitor and the more dangerous one in
Europe:

- They sell to enterprise contact centers, not developers
- Deep CCaaS integrations (Genesys, NICE, Avaya, Five9)
- Compliance, DPAs, and security reviews already solved
- Multilingual quality that's genuinely good, not an afterthought
- Slower, more expensive, less flexible — **and much higher latency**

**Strategic read:** you can beat the US developer platforms on latency and reliability. You
cannot beat Parloa/Cognigy on enterprise CX depth in year one — and you shouldn't try. Attack
where they're weak: **speed of deployment, latency, price, and self-serve motion**, while
matching them on the compliance posture that gets you through procurement.

---

## 2. Compliance moves to Phase 1

In India, compliance could reasonably be Phase 3. In EU+US it is a **gate on the first
enterprise deal**, and retrofitting it is far more expensive than building it in.

### European Union / UK

| Requirement | What it means for us | Priority |
|---|---|---|
| **GDPR** ⚖️ | Lawful basis for processing; we are a **processor**, customer is controller; DPA with every customer; sub-processor register; DSAR and right-to-erasure APIs; breach notification within 72h; **data residency in the EU** | **P1** |
| **EU AI Act** ⚖️ | A voice agent talking to a human is a transparency-obligation case: **the caller must be informed they're interacting with AI**. Obligations phase in through 2026–27. | **P1** |
| **ePrivacy / recording consent** ⚖️ | Varies by member state. Germany and France are effectively **two-party consent**; UK is one-party with ICO guidance. Must be configurable per jurisdiction, not global. | **P1** |
| **Works councils (Betriebsrat)** 🇩🇪 | In Germany, tools affecting employees often need works-council approval. Real for contact centers, and it lengthens deals. | Sales |
| **ISO 27001** | Table stakes for EU enterprise procurement | P2 |
| **EU data residency** | Frankfurt and/or Ireland cells; EU data never egresses | **P1** |

### United States

| Requirement | What it means for us | Priority |
|---|---|---|
| **TCPA + FCC AI-voice ruling** ⚖️ | The FCC has treated AI-generated voices as "artificial" under the TCPA — meaning **prior express written consent** for outbound to mobiles. This materially constrains AI cold-calling. | **P1 — see §3** |
| **STIR/SHAKEN** | Mandatory attestation; A-level attestation drives answer rates | P2 |
| **State two-party consent** ⚖️ | CA, FL, WA, PA, IL and others require all-party consent to record. Per-state config, driven by the callee's number. | **P1** |
| **DNC (national + state + internal)** | Enforced at dispatch, immutable log | P2 |
| **SOC 2 Type II** | Table stakes for US enterprise. Start the observation window early — it's a calendar constraint, not an engineering one. | **P1 to start** |
| **CCPA/CPRA** | Consumer rights APIs; largely satisfied by the GDPR work | P2 |
| **HIPAA** | Only if selling healthcare; requires BAA + specific controls | Conditional |
| **PCI DSS** | If taking card payments by voice — DTMF path that never touches the model | P2 |

**Practical consequence:** the Compliance Engine (`docs/03` §K) and streaming PII redaction
(§E) move from Phase 3 to **Phase 1**. So does the AI-disclosure mechanism, which is trivial to
build and legally required in the EU.

---

## 3. The outbound business model needs rethinking in the US ⚖️

This is the most important strategic point in this document.

With AI voices treated as "artificial" under the TCPA, **US outbound cold-calling to mobiles
requires prior express written consent**. That undercuts the "50,000 cold calls a day" pitch
that much of the category sells on. Penalties are per-call and plaintiff-friendly.

**What remains strongly viable in the US:**
- **Inbound** — customer service, support, reception, after-hours. No consent problem.
- **Outbound to existing customers with consent** — appointment reminders, renewals,
  collections on existing debt, delivery coordination, surveys of opted-in customers
- **B2B outbound** — lighter restrictions than B2C mobile ⚖️
- **Warm/triggered outbound** — inbound-lead callback within minutes, which is the highest-ROI
  outbound use case anyway

**Recommendation:** position inbound-first in the US, with outbound framed around consented
and existing-customer contact. Build the consent-capture and proof-of-consent infrastructure as
a *product feature* — it's a genuine differentiator, since the incumbents largely leave
compliance as the customer's problem. In the EU the constraints differ but the direction is
the same: consent and disclosure are load-bearing.

---

## 4. Language is a real wedge

The US developer platforms are English-first, and their German, French, Italian, and Dutch
quality is mediocre — wrong prosody, mangled compound nouns, poor handling of formal register.
European enterprises will not deploy that to their customers.

**Priority languages:** English (US/UK), German, French, Spanish, Italian, Dutch, Portuguese,
Polish, plus Nordic for the enterprise tail.

What "good" requires, per language:
- Native-quality TTS with correct prosody and **formal/informal register** (du/Sie, tu/vous —
  getting this wrong is offensive to a German or French customer in a way it isn't in English)
- ASR tuned for that language's telephony audio, including regional accents (Bavarian, Swiss
  German, Québécois, Andalusian)
- **Language-specific text normalization** — German compound nouns and number formats, French
  liaison, Dutch and Scandinavian number reading. This is `docs/03` §D, and it's where most
  platforms are visibly bad.
- Per-language endpointing: pause distributions and prosodic completion cues differ across
  languages, so the endpointer needs per-language calibration.

`docs/03` §C (language router) stays, but retargeted: **mid-call switching matters less than
per-language excellence.** Hinglish code-switching drops off the roadmap.

**This is a defensible wedge.** "The only sub-400ms voice platform with native-quality German"
is a sharper pitch in Frankfurt than anything about generic latency.

---

## 5. Infrastructure — the EU margin problem

The self-hosting thesis in `docs/01` §10 assumes cheap GPUs. That assumption is weaker in
Europe.

| | US | EU |
|---|---|---|
| GPU supply | Good — CoreWeave, Crusoe, Lambda | Tighter, more expensive |
| Bare-metal GPU options | Many | Scaleway, OVH, Nebius (FI), Nscale (NO), plus colo |
| Power cost | Lower | Higher, especially DE |
| Latency to carriers | Excellent | Good, but needs per-country PoPs |

**Recommendations:**
- **Cells:** `us-east`, `us-west`, `eu-west` (Ireland), `eu-central` (Frankfurt). Frankfurt
  specifically — German customers frequently require in-country, not just in-EU.
- Nordic capacity (Finland/Norway) is worth evaluating for training and batch work: cheap
  renewable power, though latency rules it out for inference serving Southern Europe.
- **Expect EU compute to cost more than US.** Model the margin separately per region rather
  than assuming one blended number.
- ⚖️ **Number acquisition in the EU is genuinely harder than the US:** several countries
  (Germany, Italy, Spain among them) require a local address or entity to hold numbers. Budget
  legal and entity setup time — this is a real barrier to entry, and once cleared, a moat.

---

## 6. What changes in the plan

| Area | Was | Now |
|---|---|---|
| Competitors | Vapi, Retell, Bolna, Gnani | Vapi/Retell/Bland (dev) + **Parloa/Cognigy/PolyAI (EU enterprise)** |
| Compliance | Phase 3 | **Phase 1** — GDPR, AI Act disclosure, consent config, PII redaction |
| Certifications | Unplanned | **Start SOC 2 observation window early**; ISO 27001 in P2 |
| Languages | Hinglish code-switching | **Native-quality DE/FR/ES/IT/NL**, register-aware |
| Outbound | Core pitch | **Inbound-first in the US**; consented/existing-customer outbound ⚖️ |
| Regions | Generic | `us-east`, `us-west`, `eu-west`, **`eu-central` (Frankfurt)** |
| Margin model | One blended number | **Per-region** — EU compute costs more |
| Tenancy | Workspace + compliance profile | Unchanged, and now clearly correct — per-jurisdiction config is mandatory here |

`docs/12`'s recommendation holds and gets *stronger* in this market: a workspace-level
**compliance profile** (jurisdiction, consent model, disclosure text, recording rules,
residency) is not a nice-to-have in EU+US — it's the thing that gets you through procurement.
The incumbents leave it to the customer, and in these two markets that's a losing position.

---

## 7. Go-to-market read

**US:** self-serve developer motion first (the Vapi playbook, executed better), then land
enterprise on latency + reliability + SOC 2. Inbound use cases lead.

**EU:** enterprise-led, slower, procurement-heavy. Germany is the biggest CX market and the
hardest to enter — GDPR rigour, works councils, in-country data. But **if you win German
enterprise you have a moat**, precisely because it's hard.

**Sequencing:** prove the product in the US self-serve market where the sales cycle is weeks,
then take the compliance posture you were forced to build for the EU and use it to close US
enterprise too. Build for the EU, sell first in the US.
