# Results

Generated from `config/targets.json` and the latest local recording for each target. No live requests are made by this report command.

Check outcomes summarize only the recorded sample. Missing recordings are reported as `not found in sample` through the terms or check results.

| Target | Mode | Terms status | Check outcomes | Sample and probe |
|---|---|---|---|---|
| detroit | audit | no-prohibition-found | T0=TERMS_GATE_OPEN; K1=present; K2=allowed_with_limits; K3=silent; K4=declared_and_honored; D1=reachable; D2=empty_or_tbd; D3=empty_or_template; D4=impossible; D5=landing_page_only | Sampled 50 \| Probed 2026-11-01 \| Rubric v1 \| Not a ranking of agency quality |
| boston | audit | no-prohibition-found | T0=TERMS_GATE_OPEN; K1=present; K2=disallowed; K3=silent; K4=declared_and_honored; D1=not_found_in_sample; D2=not_found_in_sample; D3=not_found_in_sample; D4=not_found_in_sample; D5=not_found_in_sample | Sampled 0 \| Probed 2026-11-01 \| Rubric v1 \| Not a ranking of agency quality |
| nyc | audit | allowed-with-conditions | T0=TERMS_GATE_OPEN; K1=present; K2=allowed_with_limits; K3=silent; K4=declared_and_honored; D1=reachable; D2=empty_or_tbd; D3=short; D4=stale; D5=api_or_bulk_endpoint | Sampled 50 \| Probed 2026-11-01 \| Rubric v1 \| Not a ranking of agency quality |
| chicago | audit | unclear | T0=TERMS_NOT_REVIEWED | Sampled 0 \| Probed 2026-10-31 \| Rubric v1 \| Not a ranking of agency quality |
| wikipedia | knock | allowed-with-conditions | T0=TERMS_GATE_OPEN; K1=present; K2=allowed; K3=silent; K4=none | Sampled 0 \| Probed 2026-11-01 \| Rubric v1 \| Not a ranking of agency quality |
| michigan | knock | prohibited | T0=DOOR_CLOSED_BY_TERMS | Sampled 0 \| Probed 2026-10-31 \| Rubric v1 \| Not a ranking of agency quality |
| twitch | knock | prohibited | T0=DOOR_CLOSED_BY_TERMS | Sampled 0 \| Probed 2026-10-31 \| Rubric v1 \| Not a ranking of agency quality |
