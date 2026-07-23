# VoiceAI Dashboard

Next.js 14 (App Router) · React 18.3 · Ant Design v5 · Zustand · axios.

```bash
npm install
npm run dev        # http://localhost:3100
npm run typecheck
npm run build
```

The API is expected at `http://localhost:3101` (`NEXT_PUBLIC_API_URL`) —
`backend/control-plane`. There is no mock layer: screens show their real loading
and error states until the control plane is running.

## Folder structure

```
src/
├── app/                          Routes only — thin shells that compose features
│   ├── layout.tsx                AntdRegistry + ThemeProvider (SSR style extraction)
│   ├── globals.css               The only global CSS; no product colours in it
│   ├── page.tsx                  Entry redirect → last scope, or /login
│   ├── (auth)/                   Route group: unauthenticated screens
│   │   ├── login/
│   │   ├── signup/
│   │   ├── verify-email/         6-digit code, not a magic link
│   │   ├── forgot-password/
│   │   └── reset-password/
│   └── orgs/[orgSlug]/[workspaceSlug]/
│       ├── layout.tsx            AppShell — sider + header + body
│       ├── page.tsx              Overview
│       └── welcome/              First-run "Talk to your agent"
│
├── components/                   Shared, feature-agnostic UI
│   ├── brand/                    Logo
│   ├── shell/                    AppShell, SideNav, AppHeader, switchers, mode toggle
│   └── common/                   PageHeader, StatTile, …
│
├── features/                     Domain modules — one folder per product area
│   ├── auth/components/          AuthLayout, SsoButtons
│   └── overview/components/      Charts
│
├── config/                       Static app config (nav model)
├── hooks/                        Generic hooks (useAsync)
├── lib/                          contract.ts (API types), api.ts (axios), scope.ts, format.ts
├── stores/                       Zustand slices — session, ui
└── theme/                        tokens.ts + ThemeProvider
```

Rules that keep it that way:

- **`app/` holds routing, not logic.** A page composes components and calls the
  API layer; anything reusable moves to `features/` or `components/`.
- **`lib/api.ts` is the only file that touches the network.** Every request goes
  through the shared axios instance (auth header, error normalisation, timeouts).
- **`lib/contract.ts` is the source of truth for data shapes** — mirrored by Zod
  in the backend. Never invent a type in a component.
- **The URL owns scope.** `/orgs/[orgSlug]/[workspaceSlug]/…`; no "current
  workspace" hidden in a store (docs/10 §Scoping rules 3).
- **All colour, spacing and radius comes from `theme/tokens.ts`** via antd's
  `ConfigProvider` and `antd-style`'s `createStyles`. No Tailwind, no hardcoded
  hex outside that file.

## Naming: workspace, not project

`docs/09` and `docs/10` say "project"; `docs/12` renames the second level to
**Workspace** (a business boundary — brand, business unit or end-client) and
`contract.ts` follows that. Routes therefore read `/orgs/acme/collections`.

## State

| Kind | Where |
|---|---|
| Session, permissions | `stores/session-store.ts` (async actions in the store) |
| Theme, sider collapse, per-workspace test/live mode | `stores/ui-store.ts`, persisted |
| Server data | `hooks/useAsync` for now; swap to TanStack Query when the API lands |
