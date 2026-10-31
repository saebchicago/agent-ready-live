# Agent-Ready Live rubric v1

The score describes only the small, dated sample fetched by Agent-Ready Live. It is not a ranking of agency quality. Missing data is reported as "not found in sample," never as proof that the publisher lacks it.

K3 silence and K4 Crawl-delay never lower the score. A declared Crawl-delay is a request to wait, not a readiness defect.

## Points

| Check | Maximum | Full credit | Partial credit | Zero points |
|---|---:|---|---|---|
| K1 robots.txt status | 20 | present: 20 | 4xx/no rules: 12 | server error, unreachable, or WAF block: 0 |
| K2 our agent allowed | 30 | allowed: 30 | allowed with limits: 20 | disallowed: 0 |
| D1 machine-readable catalog | 15 | reachable: 15 | none | not found in sample: 0 |
| D2 machine-readable license | 10 | URL or SPDX: 10 | prose: 5 | empty, TBD, or not found in sample: 0 |
| D3 descriptions | 10 | present: 10 | short or mixed: 5 | empty, template, or not found in sample: 0 |
| D4 dates | 10 | sane: 10 | stale: 5 | impossible or not found in sample: 0 |
| D5 sanctioned data lane | 5 | API or bulk endpoint: 5 | landing page only: 2 | not found in sample: 0 |

Deep Audit uses all 100 available points. Quick Knock uses K1 and K2, then normalizes the 50 available points to a 100-point score. Terms-prohibited targets stop at T0 and are shown as `DOOR_CLOSED_BY_TERMS`, not assigned a readiness score.

For D2 through D4, the verdict reports category counts and N sampled. A mixed sample uses the weakest observed category: empty or TBD before prose before machine-readable for D2; empty or template before short before present for D3; and impossible before stale before sane for D4. A short description has 1 to 39 trimmed characters. A stale date is more than five years before the probe. An impossible date is before 1990, after the probe date, or not parseable. D5 treats a successful HTML response as a landing page and a successful non-HTML response as an API or bulk lane.

Every verdict uses this disclosure:

`Sampled N | Probed YYYY-MM-DD | Rubric v1 | Not a ranking of agency quality`
