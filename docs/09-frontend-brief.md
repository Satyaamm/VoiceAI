# Frontend Build Brief

Hand this to the terminal/session building `frontend/`. It is written to be self-contained.

---

## Copy-paste prompt

> You are building the dashboard for an AI voice agent platform in `frontend/`.
>
> **Read these first, in order:**
> - `docs/10-tenancy-and-onboarding.md` — **the hierarchy: Organization → Project → Agent**,
>   roles, and the signup/onboarding flow. Read this first; it shapes every route and screen.
> - `docs/07-ui-stack.md` — the UI spec. This is your requirements doc.
> - `frontend/src/lib/contract.ts` — the API contract. **This is the source of truth for all
>   data shapes.** Do not invent types; import from here. If a shape is missing, add it here
>   first, then tell me so the backend stays in sync.
> - `docs/08-project-structure.md` — how the frontend fits the wider system.
> - `docs/01-architecture.md` §4 and `docs/02-call-flow.md` — background on what the numbers
>   in the UI actually mean (endpointing, speculative prefill, barge-in). Read these before
>   building the trace viewer.
>
> **This is a full multi-tenant product, not just a dashboard.** Users sign up, create an
> organization, create projects inside it, and create agents inside those. Routes are
> `/orgs/[orgSlug]/projects/[projectSlug]/...`. The header carries an **org switcher** and a
> **project switcher**. Never keep "current project" only in a store — the URL owns it.
>
> **Stack — already decided, do not substitute:**
> - Next.js 14.2 (App Router) + React 18.3 — pinned deliberately, see "Version pinning" below
> - **Ant Design v5** + `@ant-design/icons` + `@ant-design/plots` for charts
> - `@ant-design/nextjs-registry` for SSR style extraction (already a dependency — you must
>   wrap the root layout in `<AntdRegistry>` or you get FOUC on every load)
> - `antd-style` (`createStyles`) for any custom styling — it gives you theme-token access
> - **Zustand** for all client state, slice pattern, with async actions in the stores
> - **NO Tailwind. NO shadcn/ui. NO CSS files with hardcoded colors.** All color, spacing,
>   radius, and typography comes from antd theme tokens via `ConfigProvider`. Layout uses
>   antd `Layout`/`Flex`/`Space`/`Row`/`Col`, not utility classes.
>
> **Already scaffolded:** `package.json`, `tsconfig.json`, `next.config.mjs`,
> `src/lib/contract.ts`. Everything else is yours to build.
>
> **The backend is being built in parallel and is not up yet.** Build against mock data:
> put a `MOCK` flag in `src/lib/api.ts` that returns realistic fixtures, so every screen is
> fully explorable today. Keep the fetch layer thin so flipping to the real API is a one-line
> change. The API will be at `http://localhost:3101` (`NEXT_PUBLIC_API_URL`).
>
> **Build in this order:**
>
> *Foundation*
> 1. Root layout — `AntdRegistry` + `ConfigProvider`, theme tokens in their own file,
>    light/dark via `theme.darkAlgorithm`, persisted in a Zustand store.
> 2. **Auth screens** — sign up (email + password, Google/Microsoft SSO buttons), log in,
>    forgot/reset password, email verification (6-digit code input, not a magic link).
>    Marketing-grade polish here: it's the first thing anyone sees.
> 3. **First-run experience — NOT a wizard.** Read `docs/11-saas-benchmarks.md` before
>    building this. After email verification the user goes **straight to a working sample
>    agent** with a big "Talk to your agent" button (browser mic + live latency readout).
>    Org and project are auto-provisioned server-side; the user fills in **no forms**.
>    Target: **under 60 seconds from signup to hearing it talk.**
>
>    The form-heavy fields are collected **just-in-time**, not up front:
>    - *first/family name, phone* → on first team invite or first live call
>    - *org legal name, structured address, tax ID, billing email* → when adding a payment
>      method (tax-ID **label follows country**: GSTIN for IN, VAT for EU, EIN for US)
>    - *industry, size* → a dismissible profile card, never a blocker
>    - *region* → inferred from IP, confirmed before the first **live** call, locked after
>
>    Build these as focused modals/drawers triggered at those moments. Still build the
>    **country-code phone input** (flag + dial code + search) and the **structured address
>    form** — they're just used later in the journey, not at signup.
> 4. **App shell** — antd `Layout` with collapsible `Sider`, `Header` containing
>    **org switcher + project switcher** (antd `Select`/`Dropdown` with search and a
>    "create new" action), breadcrumb, **test/live mode toggle** (colour-coded, persisted per
>    project — see `docs/10` §Test/live mode), theme toggle, user menu.
>    Collapse state in Zustand, persisted. Nav: Overview, Agents, Calls, Campaigns, Numbers,
>    Analytics, Settings.
>
>    **Progressive disclosure:** a solo user with one project should never see the word
>    "project". Show the project switcher only when a second project or second member exists.
>
> *Product*
> 5. Overview — stat tiles (active calls, calls today, p50/p95 latency, success rate, cost
>    today) + latency and call-volume charts via `@ant-design/plots`.
> 6. Projects list + create-project flow + project settings.
> 7. Agents list (filterable table) + agent detail/editor with tabs: Prompt, Voice, Pipeline,
>    Tools, Versions.
> 8. Calls list — virtualised table, filter by agent/outcome/latency/date.
> 9. **Call trace viewer** — `/calls/[id]`. The most important screen in the product; see
>    `docs/07-ui-stack.md` for the full spec and the ASCII mockup. Canvas-rendered lanes, not
>    DOM. Start with waveform + turn list + per-turn latency waterfall, then add the event
>    lanes. Read `docs/02-call-flow.md` first so the lanes mean the right thing.
>
> *Administration*
> 10. Org settings (profile, address, billing details), **Members & invitations** (role
>     management, per-project grants), **API keys** (create shows the secret exactly once —
>     make that unmissable), billing/usage.
>
> **Role-aware UI:** roles are `owner`/`admin`/`billing_admin`/`member` at org level and
> `project_admin`/`developer`/`analyst`/`viewer` at project level (table in `docs/10`).
> Gate actions on permission — hide or disable with a tooltip, never render a button that
> 403s. `analyst`/`viewer` see transcripts **PII-masked**.
>
> **Design principles (from `docs/07-ui-stack.md`, non-negotiable):**
> - Latency is the product — show p50/p95 prominently everywhere it's relevant.
> - Every number is a link. "Success rate 87%" → click → the 13% that failed → their traces.
>   Never a dead-end metric.
> - Dense over airy. This is an operator console, not a marketing page.
> - Spend real effort on the theme tokens (type scale, primary color, radius, table density,
>   spacing). Default antd looks like every enterprise SaaS product, and our pitch is "we're
>   the fast, modern one."
>
> Start with steps 1 and 2, show me the shell running, then continue.

---

## Version pinning — why Next 14.2 / React 18.3

antd v5 officially targets React 16–18. React 19 needs
`@ant-design/v5-patch-for-react-19` or `message`, `notification`, and `Modal.confirm` fail
silently — and Next.js 15 requires React 19 for the App Router.

Rather than take that risk on day one for zero benefit, the dashboard runs **Next 14.2 +
React 18.3**, which is a well-trodden, stable combination with antd v5. Revisit once antd's
React 19 support is settled; there's nothing in this app that needs React 19 today.

## Division of work

| Terminal | Owns | Do not touch |
|---|---|---|
| **Backend session** | `backend/**`, `docs/**` | `frontend/**` |
| **Frontend session** | `frontend/**` | `backend/**` |
| **Shared** | `frontend/src/lib/contract.ts` — frontend edits it, backend mirrors it in Zod | — |

The contract file is the coordination point. Frontend leads on shape (it knows what the
screens need); backend conforms and validates. Any change to it should be called out
explicitly so the other side follows.

## Running it

```bash
cd frontend
npm install
npm run dev      # http://localhost:3100
```

Backend, once it's up:

```bash
cd backend/control-plane
npm install
npm run dev      # http://localhost:3101
```
