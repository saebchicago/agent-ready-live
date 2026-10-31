# Agent-Ready Live: Plan v2

Codex x TwitchCon Hackathon entry, reused for the Michigan DevFest talk "Open Data Is Not Agent-Ready (Yet)"
Owner: Saeb | v2: Sat Oct 31, 2026, about 2 AM ET | Deadline: Mon Nov 2, 2026, 2:00 PM PT (5:00 PM ET). Target submit: Mon 2:00 PM ET.

Labels: **Verified** = primary source or live probe, with date. **Modeled** = judgment or design choice. **Projected** = estimate.
v2 incorporates three independent Claude reviews: win strategy (Claude Fable), technical (Claude Opus), and risk/compliance (Claude Sonnet). External model reviews (ChatGPT, Gemini, Grok, Perplexity) are pending and will produce v3.

---

## 0. What changed from v1 (summary)

1. **Reframed as a game first, civic thesis second.** Chat sends a polite robot to knock on websites and bets on whether the door opens, slams, or makes it wait. Open data is the closer, not the opener. (All 3 reviews, Modeled)
2. **Two modes.** "Quick Knock" on popular sites reads only the files meant for bots (robots.txt, llms.txt). "Deep Audit" runs on allowlisted open-data portals only. This resolves the conflict between streamer appeal (any site) and safety (no scanner). (Synthesis, Modeled)
3. **Request budget cut from 12 to 3 per audit.** At Detroit's 60-second crawl-delay, 12 requests took about 11 minutes; 3 takes about 2. (Opus, Modeled)
4. **Allowlist only.** `!audit <url>` and `!approve` removed. SSRF guards kept anyway. (Opus + Sonnet)
5. **Judge-testable REPLAY quickstart** with no credentials. Rules require judges to have working access through the judging period. (Sonnet, Verified rule)
6. **Corrected Twitch auth.** User access token via authorization code flow; bot needs `user:read:chat` + `user:write:chat`; bot is made a moderator for higher rate limits; `channel:bot` not needed on this path. (Opus, Verified)
7. **Fair verdict language.** "Not found in sample" replaces failing grades for silence; every verdict shows sample size, probe date, rubric version. (Sonnet)
8. **Honest time estimate.** Human-only tasks are about 2 hours, but supervising Codex and testing is 12 to 20 hours of attention unless supervision is delegated (Section 7). (Opus, Projected)
9. **Engagement layer:** per-chatter prediction scores and streaks, per-check micro-bets, a personified robot. (Fable)

---

## 1. Pitch (Modeled)

Chat types `!knock steam` or `!audit detroit`. A small robot on the overlay walks to the site's door. Before each check, chat has 8 seconds to bet (`!y` / `!n`): "Will it let AI agents in?" "Does it say why?" "Real license?" The robot reads only what the site publishes for bots, waits patiently when asked ("Detroit asks for 60 seconds between knocks. We wait."), bows out when refused, and reveals a verdict with reason codes. Chatters earn points and streaks; the round MVP gets a card. The civic payoff: a live demonstration of what a well-behaved AI agent looks like, weeks after rogue agents made news, and a Michigan leaderboard of how ready public data is for agents.

---

## 2. Rules compliance matrix

| Requirement (Verified, Devpost rules/resources/emails) | How we satisfy it |
|---|---|
| Newly created Oct 23 to Nov 2 | New repo created Oct 31; no AccessMI/OurIntel/DecisionPlay code |
| Interactive, connects to Twitch | EventSub chat + Send Chat Message + OBS browser-source overlay |
| Built with Codex; shown in video and description | One main Codex thread; Codex clips captured during build |
| Codex session ID of main thread | Captured from `/status` in Phase 0 |
| Repo with all source, assets, instructions; no API keys | Public GitHub, MIT, `.env.example`, gitleaks on full history |
| Judges get free working access through judging period; installs and runs reliably | `npm i && npm run replay` runs the full overlay from fixtures, no credentials; exact test steps in Devpost text |
| Video under 3 min, public on YouTube, shows it working on Twitch + Codex | Real Twitch footage; REPLAY segments labeled on screen and disclosed |
| No third-party trademarks or copyrighted music without permission | No logos, no music (or royalty-free); site names as text only |
| Third-party APIs and data used per their terms | Per-target terms-of-use review in `docs/TOS-REVIEW.md`; drop any that prohibit automated access |
| Sponsor and Devpost may use names, likenesses, voices for 3 years | Written consent from each chatter; Saeb aware for himself |
| Other AI tools allowed | Claude for planning, review, docs, QA; Codex writes the code (Modeled) |
| No changes after deadline | Tag `v1.0-submission`; continue in a copy |

---

## 3. Can AI drive the Twitch part? Yes, with these limits

| Component | Driver |
|---|---|
| Bot, overlay, checks, tests | Codex |
| OBS scenes, recording, streaming | Script via obs-websocket (built into OBS 28+, Verified) (stretch) |
| Video edit and captions | AI-assisted ffmpeg pipeline; Saeb approves |
| Devpost form | AI browser agent drafts; Saeb clicks Submit (PAUSE) |
| Chat | Real people (2 to 3, consented) + one labeled test account. No scripted fake viewers: Twitch prohibits artificial inflation of channel statistics (Verified). Confirm test-account setup in TwitchDev Discord (Modeled) |
| Voiceover | Saeb, about 2.5 minutes (recommended, Modeled) |

**Human-only tasks (about 2 hours, Projected):** two Twitch accounts with verified email and 2FA (Verified requirement); app registration with redirect URI exactly `http://localhost:3000` (Verified, Twitch CLI token command); OBS install and stream key; OAuth consent in an incognito window logged in as the bot (Opus, Modeled); mod the bot in your channel; Codex sign-in and `/status`; recruit chatters; voiceover; final review and Submit.

---

## 4. Twitch technical facts (Verified, dev.twitch.tv, per Opus review Oct 31)

1. EventSub WebSocket accepts only user access tokens.
2. `channel.chat.message` needs `user:read:chat` from the bot; Send Chat Message needs `user:write:chat`. `user:bot` and broadcaster `channel:bot` are required only on the app-token path, where moderator status can substitute for `channel:bot`. We use the user-token path. Trade-off: no Chat Bot badge (acceptable).
3. Rate limits: non-mod bot 20 messages per 30 seconds and 1 per second per channel; mod/VIP 100 per 30 seconds; violation means the bot is ignored for 1 hour. Max 500 characters. **Make the bot a mod.**
4. Authorization code flow with refresh on 401; validate token at startup and hourly.
5. EventSub WebSocket: subscribe within 10 seconds of welcome or socket closes (4003); handle `session_reconnect` within 30 seconds (connect new, wait for welcome, close old); 300 subscriptions and 3 connections per token.
6. Native Predictions and Custom Rewards require Affiliate/Partner. We build our own `!y` / `!n` / `!predict`.
7. Test chat offline with Twitch CLI mock server (`twitch event websocket start-server`).
8. robots.txt per RFC 9309: 4xx means the crawler may fetch; 5xx means assume full disallow; cache at most 24 hours; Crawl-delay is not in the RFC. We honor Crawl-delay voluntarily (Modeled).

---

## 5. Product spec

### 5.1 Modes

| Mode | Targets | Requests (max) | Checks |
|---|---|---|---|
| **Quick Knock** `!knock <alias>` | Curated popular sites streamers care about (e.g., Twitch, Steam, Riot, a few news and university sites, the streamer's own site if configured by the streamer) | 2: `/robots.txt`, `/llms.txt` | K1 to K4 |
| **Deep Audit** `!audit <alias>` | Allowlisted open-data portals (Michigan seed list + 2 comparators) | 3: robots.txt, catalog endpoint, one sample HEAD | K1 to K4 + D1 to D5 |

Rationale: robots.txt and llms.txt are files published specifically for automated agents to read (Modeled). Quick Knock gives streamer appeal without scanning anyone. Each Quick Knock target still gets a terms-of-use check (Sonnet).

### 5.2 Checks (deterministic; no LLM grading)

| ID | Check | Outcomes (Modeled) | Michigan grounding, Oct 31 probe (Verified as observed, partial feeds, one day) |
|---|---|---|---|
| K1 | robots.txt status | Present / not found (4xx: allowed by RFC) / server error (5xx: treat as disallow) / blocked by firewall (`BLOCKED_BY_WAF`, we stop anyway) | michigan.gov has 100+ sitemaps, one with an unfilled `__CdUrl__` placeholder |
| K2 | Our agent allowed | Allowed / allowed with limits / disallowed: "Respected" | data.michigan.gov refused our research fetcher; cause (robots rule vs firewall) **unconfirmed**, re-probe before claiming |
| K3 | States an AI-use policy | Stated / partial / silent (silence shown as info, not failure) | MI School Data states `search=yes, ai-train=no, use=reference` |
| K4 | Crawl-delay | None / declared and honored (on-screen wait) | Detroit 60s, SEMCOG 10s |
| D1 | Machine-readable catalog | DCAT/data.json, Socrata catalog, or CKAN reachable / not found in sample | Detroit and Michigan GIS Hub serve DCAT-US 1.1 |
| D2 | License machine-readable | URL or SPDX / prose / empty or "TBD" in sample | Detroit feed: 35 of first 36 empty, 1 "TBD"; GIS Hub: prose disclaimer |
| D3 | Descriptions in the feed agents read | Present / short / empty or template placeholder in sample | Detroit feed: 22 of first 36 show `{{description}}` (may be a feed-template artifact; the human page may differ; verify against portal metadata) |
| D4 | Dates plausible | Sane / stale / impossible (1900 or future) | Detroit feed: 4 entries dated 1900-01-01 |
| D5 | Sanctioned data lane | API or bulk endpoint responds / landing page only | Detroit feed: 12 of first 36 point to data endpoints |

Every verdict card shows: "Sampled N entries | Probed <date> | Rubric v1 | Not a ranking of agency quality."

### 5.3 Engagement layer

- Per-check micro-bets: 8-second `!y` / `!n` window before K2, K3, D2 (Fable)
- Per-chatter points, streaks, round MVP card; in-memory with JSON dump (Fable + Opus)
- Personified robot (SVG/CSS): walks, knocks, sits during crawl-delay, bows on "Respected," cheers on pass (Fable)
- Michigan leaderboard (Deep Audit) and "Most welcoming sites" board (Quick Knock); rows show probe date and expire after 7 days (Sonnet)

### 5.4 Politeness and safety layer (single `Fetcher` module)

- User-Agent: `AgentReadyLive/0.1 (+repo URL; contact: <monitored project email>)`. Not a personal or employer address.
- Max 2 (Quick Knock) or 3 (Deep Audit) requests per audit; per-host concurrency 1; global queue; one audit at a time
- Honor robots.txt and Crawl-delay; honor 429/503 `Retry-After` by stopping, not retrying
- GET/HEAD only; 10-second timeout; 5 MB streamed byte cap; manual redirects, max 3, allowlist re-checked on every hop
- DNS resolve then connect to the pinned IP; reject private, loopback, link-local (incl. 169.254.169.254), IPv6 ULA, IPv4-mapped; ports 80/443 only
- Overlay renders fetched text with `textContent` only; CSP on overlay; local servers bound to 127.0.0.1 with Origin check
- Kill switch: `!stop` (mods) and a config flag
- No runtime LLM on fetched content (prompt-injection surface)

### 5.5 Chat hygiene

Per-user and per-command cooldowns; queue cap; bot ignores its own messages; dedupe by `message_id`; send queue at most 1 message per second; render only aliases and consenting handles on overlay; slow mode or followers-only during recording.

---

## 6. Architecture and critical path (Opus, Modeled)

Build in this order:
1. `src/config.ts` (env; allowlist entries: alias, host, mode, catalog URL, dialect)
2. `src/twitch/auth.ts` (auth code flow, refresh on 401, hourly validate, tokens in gitignored `.tokens.json` outside repo if possible)
3. `src/twitch/eventsub.ts` (welcome, subscribe within 10s, keepalive, reconnect)
4. `src/twitch/chat.ts` (send queue, 1/sec)
5. `src/commands.ts` (`!ping`, `!knock`, `!audit`, `!y`/`!n`, `!score`, `!stop`)
6. `src/audit/fetcher.ts` (Fetcher interface, LiveFetcher, ReplayFetcher with time scale, all guards, `robots-parser`)
7. `src/audit/checks.ts` (K1 to K4, then D1 to D4, then D5)
8. `src/audit/grade.ts` (published formula)
9. `src/server/state.ts` (single reducer, full snapshot on overlay reconnect) and `server.ts`
10. `overlay/` (idle, betting, auditing, waiting, verdict, MVP)
11. `fixtures/` (raw HTTP exchanges recorded once, Saturday afternoon) and `tests/`

Defer: obs-websocket director, statement card beyond static text, comparators beyond 2, SQLite, Chat Bot badge, any LLM summary.

### AGENTS.md (core rules for Codex)

1. All outbound HTTP goes through `Fetcher` in `src/audit/fetcher.ts`. No other module calls fetch/http. Never retry after a 4xx, 5xx, or robots disallow. Never exceed the per-mode request budget.
2. Before reporting a task done, run `npm run typecheck && npm test`. Every check needs pass/partial/fail fixture tests. Never edit fixtures or expected values to make a test pass; stop and report.
3. Never read, print, write, or commit `.env` or `.tokens.json`. All overlay state changes go through the reducer in `src/server/state.ts`. Do not add commands, targets, or dependencies not listed here without asking.
4. Escape all fetched content; overlay uses `textContent` only.

---

## 7. Codex strategy and Saeb's time

- One main Codex thread; session ID captured in P0 (Verified requirement)
- No hackathon credits offered (Verified). Plus + pay-as-you-go credits (credits apply to Codex for Plus/Pro, Verified); API-key CLI as fallback (third-party summary)
- Default model; GPT-5.5 left Codex Oct 14 (third-party source)
- **Attention reality (Projected, Opus):** 12 to 20 hours of supervising and testing if Saeb drives Codex directly.
- **Option to cut Saeb's attention (Unverified, test in P0):** Claude Code on Saeb's Mac orchestrates Codex non-interactively, resuming the same Codex session for each task, and reviews diffs and test output between tasks. Codex still writes the code; the session ID stays the main thread. Saeb approves at PAUSE gates only. Must confirm in P0 that resuming keeps a single session ID.

---

## 8. Phases and PAUSE gates (Projected, ET)

| Phase | When | Work | PAUSE gate |
|---|---|---|---|
| P0 Setup | Sat 9 to 10:30 AM | Accounts, 2FA, app (redirect `http://localhost:3000`), OBS, mod bot, Codex `/status`, repo + AGENTS.md, decide orchestration | Session ID captured; no secrets in repo dir |
| P0.5 Outreach + ToS | Sat 10:30 to 11:30 AM | Email Detroit Open Data and DTMB a heads-up with right of reply (do not wait for answer); terms-of-use review per target | Drop any target that prohibits automation |
| P1 Hello Twitch | Sat 11:30 AM to 2 PM | auth, eventsub, chat queue, `!ping`; Twitch CLI mock tests | Bot replies in live channel |
| P2 Checks + fixtures | Sat 2 to 10 PM | Fetcher + guards, K1 to K4, D1 to D5, record fixtures, tests | Tests green; K2 cause for data.michigan.gov confirmed; D3 checked against portal metadata |
| P3 Overlay + game | Sun 9 AM to 2 PM | State reducer, overlay states, robot, bets, scores, MVP | Readable at 1080p in OBS; reconnect works |
| P4 Record | Sun 3 to 7 PM | Rehearsal; 20-minute live session with consented chatters; Codex clips; REPLAY quickstart verified on a clean clone | 3 clean rounds on tape incl. one crawl-delay wait and one "Respected" |
| P5 Video | Sun 7 to 11 PM | Script, voiceover, edit, captions | Under 3:00; no secrets on screen; REPLAY labeled |
| P6 Submit | Mon 8 AM to 2 PM ET | YouTube upload by 10 AM; README; Devpost text with test steps; gitleaks; rotate secrets; tag | Saeb reviews and clicks Submit by 2 PM ET |

**Cut order if behind:** director script, Quick Knock extra targets, MVP card animation, D5, comparators, robot animation (keep static robot).

---

## 9. Video (under 3:00) (Fable, revised)

| Time | Beat |
|---|---|
| 0:00 to 0:12 | Cold open on product: `!audit detroit` hits overlay; robot knocks; ticker `GET /robots.txt 200`; chat bets; tile stalls: "Detroit asks us to wait 60 seconds. We wait." Robot sits. |
| 0:12 to 0:20 | VO: "This is an AI agent that asks permission. Your chat bets on which websites say yes." Title card. |
| 0:20 to 1:20 | Quick Knock round on popular sites (fast, funny); a "Respected" refusal; MVP card |
| 1:20 to 1:55 | Deep Audit verdict with reason codes and sample label; MI School Data as the positive "says why" example |
| 1:55 to 2:15 | Codex proof, 20 seconds: thread, tests passing, one fix |
| 2:15 to 2:45 | Why it matters, 15 to 30 seconds: "In June, an AI agent researching public health spending gained unauthorized access to an Australian government portal." (Verified, AP/Reuters Sept 2026 reporting of a June 18 incident) "Agents need a front door. Publishers need to say why when it's closed." |
| 2:45 to 2:58 | End on chat reacting to a verdict + "Any streamer, any site's front door, 90 seconds, chat keeps score." |

---

## 10. Judging map (Modeled)

| Criterion | v1 score (Fable) | v2 lever |
|---|---|---|
| Innovation | 7 | Polite agent as a betting game; timely |
| Impact for streamers | 4 | Quick Knock on sites streamers care about; scores and streaks bring chat back |
| Tech + Codex | 7 | Real Twitch integration, safety layer, fixtures, tests, judge-testable REPLAY, visible Codex thread |
| Design | 5 | Robot character, micro-bets fill waits, MVP card |

Odds remain low single digits % (Projected); v2 aims to move Impact from weakest to neutral.

---

## 11. Risk register (v2)

| # | Risk | Mitigation | Blocker? |
|---|---|---|---|
| R1 | Impact for streamers low | Quick Knock, scores, robot | No |
| R2 | Judges cannot test | REPLAY quickstart, test steps | **Yes** |
| R3 | SSRF / scanner abuse / XSS | Allowlist only, guards in 5.4 | **Yes** |
| R4 | Secrets on screen or in repo | Secrets outside repo; clean browser profile; gitleaks; rotate after recording | **Yes** |
| R5 | Unfair or wrong claims about named agencies | Sample labels, "not found in sample," verify K2 and D3, heads-up emails, positive examples | **Yes** for claims |
| R6 | Portal or site terms prohibit automation | `docs/TOS-REVIEW.md`; drop target | **Yes** per target |
| R7 | Employer policy (outside activity, IP, speaking) | Saeb reads policy; personal time/equipment; employer omitted from project materials unless cleared | Saeb to decide |
| R8 | Chatter consent and chat content | Written consent; aliases only; slow mode | **Yes** |
| R9 | Codex limits | Credits; fallback | No |
| R10 | Time and attention | Orchestration option, cut order | No |
| R11 | YouTube processing | Upload by Mon 10 AM | No |
| R12 | Twitch ToS on test account | Confirm in Discord | No |
| R13 | Legal exposure of automated fetching | GET-only, 2 to 3 requests, honor robots, ToU review. Not legal advice; exposure looks low for public reads, but state statutes and site terms are separate (Modeled) | No |

---

## 12. DevFest reuse (Modeled)

Full Michigan re-audit by Nov 10 with the same engine; talk arc: Australia incident, no sanctioned lane, Michigan measured gaps, "open by default, explain by exception," live round on stage; Agent Access Statement template as takeaway.

---

## 13. Synthesis record (multi-model review, Oct 31)

### Conflict register

| # | Issue | Fable (win) | Opus (tech) | Sonnet (risk) | Resolution |
|---|---|---|---|---|---|
| 1 | Arbitrary sites | Let chat audit any site | Allowlist only | Disable URL mode; ownership proof if kept | Two modes: Quick Knock (bot files only, curated list) + Deep Audit (allowlist) |
| 2 | Crawl-delay wait | Make it a comedic beat | 12 requests = 11 min; cut to 3 | n/a | 3-request budget + robot sits + micro-bets fill wait |
| 3 | data.michigan.gov "refusal" | n/a | Probably firewall 403, not robots | 403 is not a robots Disallow | Cause unconfirmed; re-probe in P2 before any claim |
| 4 | Medicare hook date | n/a | n/a | Said "June" conflicts with Sept | Not a conflict: incident June 18, disclosed Sept (Verified, AP). Wording changed to "gained unauthorized access" |
| 5 | Human time | n/a | 12 to 20 hours attention | n/a | Accepted; orchestration option added |
| 6 | Civic thesis placement | Closer, not lead | n/a | Fair claims | Closer, with sample labels |

### Claims excluded from v2

- "First live agent-readiness audit" (unprovable)
- "Zero compliance risk"
- "Only MI School Data states intent among 9 probed" as a general finding (one day, partial feeds; kept only as an observed example)
- "data.michigan.gov refuses agents" (cause unconfirmed)
- "About 2 hours total" as Saeb's full time

### Blind spots still open (for external reviewers)

1. Has anyone shipped a similar Twitch bot or segment?
2. Any Codex x TwitchCon rules clarification on AI voiceover, test accounts, REPLAY footage?
3. Twitch policy on bots fetching external sites and showing results in chat
4. Best Quick Knock target list that streamers find funny but whose terms allow automated reads of robots.txt
5. Whether Claude Code can drive Codex while keeping one session ID

---

## 14. Decisions for Saeb

| # | Decision | Default |
|---|---|---|
| D1 | Name | Agent-Ready Live (decided Oct 31) |
| D2 | Codex driving: you drive directly, or Claude Code orchestrates Codex with you at PAUSE gates | Claude Code orchestrates (if P0 test passes) |
| D3 | Codex plan: Plus + credits, Pro, or API key | Plus + credits |
| D4 | Voice: yours or AI | Yours |
| D5 | Chatters (2 to 3, consented) | AI Collective Detroit contacts |
| D6 | Employer mention in project materials | Omit |
| D7 | OS | macOS (assumed) |
| D8 | Monitored project contact email for User-Agent | New project alias |
