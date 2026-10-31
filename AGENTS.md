# AGENTS.md: rules for Codex on this repo

Project: "Agent-Ready Live", a Twitch chat game for the Codex x TwitchCon Hackathon.
Full plan: `docs/PLAN.md`. Read it before every new phase.

## Scope
- Build only what the current phase prompt asks for. Do not add commands, targets, dependencies, or features that are not in `docs/PLAN.md` or the phase prompt without asking first.
- Core code is built in this Codex thread. Keep working in this thread.

## Safety and politeness (non-negotiable)
1. All outbound HTTP to audited sites goes through the `Fetcher` interface in `src/audit/fetcher.ts`. No other module calls `fetch`, `http`, or `https` for audit targets. (Twitch API calls live in `src/twitch/` only.)
2. Request budget: Quick Knock max 2 requests, Deep Audit max 3. Never exceed it.
3. Honor robots.txt and Crawl-delay. Never retry after a 4xx, 5xx, 429, 503, or a robots disallow. Never change the User-Agent to get around a block.
4. GET and HEAD only. No forms, no auth, no query fuzzing, no guessing hidden paths.
5. Targets come only from `config/targets.json`. Refuse any target whose `tosReviewed` is not `true`. If `tos.status` is `"prohibited"`, send ZERO network requests to that host: show the terms finding (evidence + sourceUrl) as check T0 and stop.
6. SSRF guard: resolve DNS, then connect to the pinned IP. Reject private, loopback, link-local (including 169.254.169.254), IPv6 ULA, and IPv4-mapped addresses. Ports 80 and 443 only. Follow redirects manually, max 3, and re-check the allowlist on every hop. Stream responses with a 5 MB cap. 10-second timeout.
7. The overlay renders fetched content with `textContent` only. Never `innerHTML` with fetched or chat text. Overlay page sets a strict CSP.
8. Local servers bind to 127.0.0.1 and check the Origin header.
9. No runtime LLM calls on fetched content.

## Secrets
- Never read, print, write, or commit `.env` or the tokens file (`TOKENS_PATH`, default `~/.agent-ready-live/tokens.json`, outside the repo).
- `.env.example` lists variable names only.
- Never log tokens, client secrets, stream keys, or the obs-websocket password.

## Quality
- Before reporting any task done, run `npm run typecheck && npm test` and include the output summary.
- Every audit check has tests for each outcome (pass, partial, fail, and any special code such as `BLOCKED_BY_WAF`).
- Never edit fixtures or expected values to make a test pass. If a test fails for a reason you cannot fix, stop and report.
- Test-only synthetic fixtures live in `tests/fixtures/synthetic/` and are named as synthetic. Real recorded fixtures live in `fixtures/recorded/` with the recording date in the file.

## Accuracy of on-screen claims
- Verdicts never claim more than the sample shows. Use "not found in sample" for missing items, never a failing grade for silence.
- Every verdict and leaderboard row shows: sample size, probe date, rubric version.
- Replayed data is labeled REPLAY on the overlay.

## Git
- Do not run `git commit`, `git push`, or merge. When work is ready, propose a commit message and stop. The owner approves every commit (PAUSE gate).

## Style
- TypeScript strict mode. Small modules. No em dashes in any user-facing text, README, or docs.
