# Contributing

Contributions are welcome. **`main` is protected — nothing lands without a
reviewed pull request.** Direct pushes are rejected by the server, not by
convention.

## Workflow

```bash
# 1. Fork, then clone your fork
git clone https://github.com/<you>/VoiceAI.git
cd VoiceAI

# 2. Branch. Never work on main.
git checkout -b feat/semantic-endpointer-prosody

# 3. Install
cd backend/control-plane && npm install
cd ../../frontend        && npm install

# 4. Verify before you push — CI runs exactly this
cd backend/control-plane && npx tsc --noEmit
cd ../../frontend        && npx tsc --noEmit

# 5. Push and open a PR against main
```

Branch names: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`.

## What gets a PR merged

1. **CI green.** Typecheck must pass for both packages.
2. **One approving review** from a code owner.
3. **No secrets.** See below — this is non-negotiable and automatically checked.
4. **Scope is one thing.** A PR that fixes a bug *and* renames forty files is two PRs.

## Before you open a PR

- [ ] `npx tsc --noEmit` passes in `backend/control-plane` **and** `frontend`
- [ ] No `.env`, key, credential, recording, or model weight added
- [ ] New provider/strategy registered in the relevant registry, not `new`'d at a call site
- [ ] Repository methods take a scope as their **first** argument
- [ ] Anything user-facing that speaks to a caller has translations, in **both registers** for T-V languages

## Architecture rules that reviewers will enforce

These aren't style preferences — breaking them causes real defects. Full reasoning
lives in [`docs/`](./docs).

| Rule | Why |
|---|---|
| **Never construct a provider with `new` at a call site** | Registry + Factory exist so agent config can name a provider and tests can substitute one. See `src/core/patterns/`. |
| **Every repository method takes a scope first** | Cross-tenant access must be a *compile* error, not a code-review catch. There is deliberately no `findAll()`. |
| **`authorize()` is the only producer of a `TenantScope`** | It's brand-typed with a private symbol. If you find yourself casting to forge one, stop. |
| **Cross-tenant reads return 404, not 403** | Never confirm a resource exists to someone outside its tenant. |
| **Nothing blocks the turn loop for >30ms** | It's a phone call. A slow dependency is worse than a failed one. |
| **On barge-in, truncate context to what was actually *played out*** | Not what was generated. Getting this wrong is why competing agents "forget" they were interrupted. |
| **PII redaction runs before the LLM, not just before storage** | Sending a transcript to a vendor is a disclosure to a sub-processor. |
| **Compliance rules live in data, not logic** | Legal corrections must not require a deploy. |
| **Both a strategy and its naive baseline stay registered** | You cannot claim a latency win without measuring against what you claim to beat. |

## Absolutely never commit

- `.env` files, API keys, tokens, certificates, KMS material
- Call recordings, transcripts, or any real caller data — these are **personal data**,
  and PHI in healthcare workspaces (see [`docs/14`](./docs/14-compliance-controls.md))
- Model weights or checkpoints — use object storage
- `node_modules/`, build output

If you commit a secret: **rotate it first**, then rewrite history. Rotation is the
urgent part; a key in a public repo is compromised the moment it is pushed, and
deleting the commit does not un-compromise it.

## Reporting a security issue

**Do not open a public issue.** Email the maintainer directly. Include steps to
reproduce and, if you have one, a suggested fix. We'll acknowledge within 72 hours —
the same clock GDPR Art. 33 gives us for a breach, which is a useful forcing function.

## Legal and compliance content

[`docs/`](./docs) contains compliance analysis and regulatory interpretation. It is
engineering documentation, **not legal advice**, and items marked ⚖️ are explicitly
unresolved questions pending review by counsel. Do not treat any of it as a
compliance guarantee, and do not cite it as one.

## Code style

Match the surrounding code. Comments explain **why**, not what — if a comment
restates the line beneath it, delete the comment. Reference the relevant `docs/`
section when a decision has a documented rationale.
