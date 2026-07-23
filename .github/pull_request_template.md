## What and why

<!-- What changes, and what problem it solves. Link the docs/ section if there is one. -->

## Verification

<!-- How you know it works. Paste output, not adjectives. -->

- [ ] `npx tsc --noEmit` passes in `backend/control-plane`
- [ ] `npx tsc --noEmit` passes in `frontend`

## Checklist

- [ ] No `.env`, key, credential, recording, or model weight added
- [ ] Repository methods take a scope as their first argument
- [ ] Providers/strategies registered in a registry, not `new`'d at a call site
- [ ] Caller-facing strings have translations in both registers for T-V languages
- [ ] Compliance rules changed in **data**, not logic

## Risk

<!-- What could this break? What did you deliberately not change? -->
