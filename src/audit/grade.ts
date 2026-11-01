import type { TargetMode } from "../config.js";
import type { CheckResult } from "./checks.js";

export const RUBRIC_VERSION = "rubric v1";

export interface GradeResult {
  score: number;
  verdict: string;
}

const POINTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  K1: {
    present: 20,
    not_found: 12,
    server_error: 0,
    unreachable: 0,
    BLOCKED_BY_WAF: 0,
  },
  K2: { allowed: 30, allowed_with_limits: 20, disallowed: 0 },
  D1: { reachable: 15, not_found_in_sample: 0 },
  D2: { url_or_spdx: 10, prose: 5, empty_or_tbd: 0, not_found_in_sample: 0 },
  D3: { present: 10, short: 5, empty_or_template: 0, not_found_in_sample: 0 },
  D4: { sane: 10, stale: 5, impossible: 0, not_found_in_sample: 0 },
  D5: { api_or_bulk_endpoint: 5, landing_page_only: 2, not_found_in_sample: 0 },
};

const MAX_POINTS: Readonly<Record<string, number>> = {
  K1: 20,
  K2: 30,
  D1: 15,
  D2: 10,
  D3: 10,
  D4: 10,
  D5: 5,
};

export function gradeAudit(
  mode: TargetMode,
  checks: readonly CheckResult[],
  sampledEntries: number,
  probedOn: string,
): GradeResult {
  const included = mode === "knock"
    ? new Set(["K1", "K2"])
    : new Set(["K1", "K2", "D1", "D2", "D3", "D4", "D5"]);
  let earned = 0;
  let possible = 0;
  for (const check of checks) {
    if (!included.has(check.id)) continue;
    const maximum = MAX_POINTS[check.id];
    if (maximum === undefined) continue;
    possible += maximum;
    earned += POINTS[check.id]?.[check.outcome] ?? 0;
  }
  const score = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  const sampleText = mode === "knock"
    ? "Knock only: no catalog sampled"
    : sampledEntries === 1
      ? "Sampled 1"
      : `Sampled ${sampledEntries}`;
  return {
    score,
    verdict: `${sampleText} | Probed ${probedOn} | Rubric v1 | Not a ranking of agency quality`,
  };
}
