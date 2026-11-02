# Agent-Ready Live

Agent-Ready Live is a chat game where a small, polite robot reads the public files a website publishes for automated visitors and chat predicts what it will find. It makes crawler rules visible, shows when a publisher asks for a wait or says no, and samples open data catalogs to show what agents can actually find. The aim is to make respectful agent behavior easy to see and discuss. **Modeled:** results describe a limited sample, not an agency's overall quality.

## 60-second judge quickstart

**Verified:** the offline demo uses only recorded fixtures and runs without Twitch credentials or target-site requests.

```sh
git clone https://github.com/saebchicago/agent-ready-live.git
cd agent-ready-live
npm ci
npm run demo
```

Open <http://127.0.0.1:3000> in a browser or an OBS Browser Source. In the terminal running the demo, type `!y` or `!n` during a prediction, then press Enter. Use Ctrl+C to stop. `npm run demo -- --smoke` runs one round and exits.

## Commands

| Command | What it does | Label |
|---|---|---|
| `!knock <alias>` | Queue a Quick Knock target | Verified |
| `!audit <alias>` | Queue a Deep Audit target | Verified |
| `!y` / `!n` | Place a prediction during the betting window | Verified |
| `!score` | Show your points and streak | Verified |
| `!board` | Show the current leaderboard | Verified |
| `!why` | Replay the most recent check explainer card | Verified |
| `!fix` | Post a sampled fix-it suggestion, when available | Modeled |
| `!national` | Summarize the recorded Data.gov national catalog facets | Verified |
| `!publisher <name>` | Show a publisher count from the recorded organization facet | Verified |
| `!trap` | Show the Census sentinel-value trap and corrected sample list | Modeled until a Census fixture is recorded |
| `!whois` | Identify the demo bot | Modeled |
| `!stop` | Stop queued audits, available to a broadcaster or moderator in Twitch mode | Verified |

The demo also plays these recorded rounds: Wikipedia, Boston, NYC, Detroit, Michigan, Twitch, SAM.gov, and ArcGIS Hub. **Verified:** prohibited targets stop at T0 with zero requests. All replay rounds show the REPLAY badge. Each round is placed on the five-step door ladder and shows explainers after check results. Closed doors show configured side-door information. **Modeled:** the between-round France and EU context card has no source link yet.

**Verified:** `catalog-census` records the Data.gov robots file and at most two CKAN facet responses. It waits for the configured 10-second Crawl-delay, honors the 5 MB response cap, and reports missing facets or a truncated second response without estimating.

To create the local national-catalog fixture, a maintainer can run `npm run record -- datagov`. This makes one robots request and up to two package search calls. The recorder sanitizes cookie headers. ArcGIS Hub is terms-gated and sends zero requests; Detroit's portal platform terms question remains unresolved, as described in [docs/TOS-REVIEW.md](docs/TOS-REVIEW.md).

The recorded Data.gov legacy CKAN 404 is shown as evidence that agents using stale endpoint documentation can fail. To record the v4 census, run `npm run record -- datagov-v4`. The recorder uses `DATAGOV_API_KEY` only in the `X-Api-Key` request header, makes one organizations call and up to five publisher searches, and omits request headers and the key from fixtures. National publisher/type totals are **Verified** from the organizations response. License shares are **Modeled** from the returned sample of up to 100 records per publisher.

**Verified:** `census-wayne` uses one ACS 5-year 2024 Wayne County tract request after checking `robots.txt`. Run `npm run record -- census-wayne` to save a local fixture. Set `CENSUS_API_KEY` in the maintainer environment; the key is used only for the API request and is removed from ticker events and recorded URLs. The offline demo includes a clearly labeled synthetic Census response until a recording exists. It shows Census sentinel values as missing with reasons, compares the naive raw sort with the corrected income and margin-of-error list, and displays the required Census Bureau notice. The counts and values shown come from the fixture.

**Verified:** the ArcGIS Hub terms card says, “Publisher says open. Platform says no AI harvesting.” It shows the configured publisher DCAT-US route as a side door, without making a request to ArcGIS Hub.

## Checks

The scoring formula and outcome definitions are in [docs/RUBRIC.md](docs/RUBRIC.md).

| ID | Check | What it reports | Label |
|---|---|---|---|
| T0 | Terms gate | Whether the reviewed terms allow the audit to start | Verified |
| K1 | robots.txt status | Present, not found, server error, unreachable, or WAF block | Verified |
| K2 | Agent access | Whether the planned path is allowed, limited, or disallowed, including the matching rule | Verified |
| K3 | AI-use policy | A published AI-use signal, AI-specific agent rules, or silence | Verified |
| K4 | Crawl-delay | A declared delay, which the robot honors, or no delay | Verified |
| D1 | Catalog | Whether a supported machine-readable catalog is reachable | Verified |
| D2 | License | URL or SPDX identifier, prose, or empty/TBD in the sample | Verified |
| D3 | Description | Present, short, or empty/template descriptions in the sample | Verified |
| D4 | Dates | Sane, stale, or impossible dates in the sample | Verified |
| D5 | Data lane | Whether one sampled distribution endpoint responds | Verified |

**Modeled:** Deep Audit samples at most 50 catalog entries and one distribution. Missing fields are reported as “not found in sample.” The generated [docs/RESULTS.md](docs/RESULTS.md) summarizes the local recordings.

**Verified:** `npm run note -- boston` writes a local publisher note at `docs/notes/boston.md` from the fixture. Notes are never sent automatically. For a sampled D2, D3, or D4 issue, the overlay shows the raw sampled field before and a described fix without inventing replacement values.

## Safety design

- **Verified:** terms are checked first; a prohibited target receives zero requests.
- **Verified:** robots.txt follows RFC 9309 handling, including no rules for 4xx and full disallow for 5xx or unreachable.
- **Modeled:** declared Crawl-delay is honored to be polite, even though RFC 9309 does not define it.
- **Verified:** Quick Knock permits at most 2 requests and Deep Audit at most 3, with GET and HEAD only.
- **Verified:** DNS pinning, private IP rejection, ports 80/443 only, manual redirects with allowlist checks, streamed size limits, and timeouts protect outbound requests.
- **Verified:** the overlay server binds to 127.0.0.1, checks Origin, uses a strict CSP, and inserts fetched text with `textContent`.

The ladder labels are Closed by terms, Closed by robots, Open with gaps, Open by law, and Agent lane offered. **Modeled:** a ladder placement summarizes only configured terms and this round's checks.

## Live Twitch setup for maintainers

The judge demo does not need Twitch. To run the live bot:

1. Install Node.js 22 or newer and create a Twitch developer application with redirect URL `http://localhost:3000`.
2. Copy `.env.example` to `.env` and fill in the Twitch application ID and secret, bot and channel user IDs, token path, contact email, repository URL, and any consenting handles.
3. Run `npm ci`, then `npm run auth` and complete the authorization flow as the bot account. Keep the token file outside the repository.
4. Make the bot a moderator in the channel, then run `npm run dev`.
5. Add `http://127.0.0.1:3000` as a 1920 by 1080 OBS Browser Source.

Do not commit `.env` or the token file. **Modeled:** only use live audit mode for targets reviewed in `config/targets.json` and `docs/TOS-REVIEW.md`.

## Built with Codex

This project was built in a Codex session. **Verified:** source, checks, tests, fixtures, and this judge quickstart are included in the repository.

Codex session ID: **[Add the session ID here]**
