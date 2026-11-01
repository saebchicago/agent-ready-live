import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { targets, type Target } from "../src/config.js";
import {
  checkD1,
  checkD2,
  checkD3,
  checkD4,
  checkD5,
  checkK1,
  checkK2,
  checkK3,
  checkK4,
  checkT0,
  parseCatalog,
  runAuditChecks,
} from "../src/audit/checks.js";
import { gradeAudit } from "../src/audit/grade.js";
import type {
  AuditRecording,
  FetchResponse,
  RobotsKind,
  RobotsPolicy,
} from "../src/audit/fetcher.js";
import { ReplayFetcher } from "../src/audit/fetcher.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/synthetic/check-cases.json", import.meta.url), "utf8"),
) as {
  robots: Record<"stated" | "partial" | "silent", string>;
  catalogs: Record<string, unknown>;
};

function target(overrides: Partial<Target> = {}): Target {
  return {
    alias: "synthetic",
    name: "Synthetic target",
    host: "example.test",
    mode: "audit",
    catalogUrl: "https://example.test/data.json",
    dialect: "dcat",
    tos: {
      status: "no-prohibition-found",
      sourceUrl: "https://example.test/terms",
      evidence: "Synthetic terms permit this test.",
      reviewedOn: "2026-10-31",
    },
    tosReviewed: true,
    notes: "Synthetic test target",
    ...overrides,
  };
}

function policy(
  kind: RobotsKind,
  options: { allowed?: boolean[]; crawlDelayMs?: number; matchingLine?: number } = {},
): RobotsPolicy {
  let index = 0;
  return {
    kind,
    ...(kind === "unreachable" ? {} : { status: kind === "server_error" ? 503 : kind === "not_found" ? 404 : kind === "BLOCKED_BY_WAF" ? 403 : 200 }),
    text: "",
    crawlDelayMs: options.crawlDelayMs ?? 0,
    stopped: kind === "server_error" || kind === "unreachable" || kind === "BLOCKED_BY_WAF",
    isAllowed: () => options.allowed?.[index++] ?? (kind === "present" || kind === "not_found"),
    matchingLine: () => options.matchingLine ?? -1,
  };
}

function response(
  status: number,
  headers: Record<string, string> = {},
  body = "",
): FetchResponse {
  return {
    url: "https://example.test/value",
    method: "GET",
    status,
    headers,
    body: Buffer.from(body),
    timestamp: "2026-10-31T12:00:00.000Z",
    ms: 5,
  };
}

function catalog(name: string) {
  return parseCatalog(JSON.stringify(fixture.catalogs[name]), "dcat");
}

describe("T0 terms gate", () => {
  it("covers open, prohibited, and unreviewed outcomes without a fetcher", async () => {
    expect(checkT0(target()).outcome).toBe("TERMS_GATE_OPEN");
    expect(checkT0(target({ tos: { ...target().tos, status: "prohibited" } })).outcome).toBe("DOOR_CLOSED_BY_TERMS");
    expect(checkT0(target({ tosReviewed: false })).outcome).toBe("TERMS_NOT_REVIEWED");

    let called = false;
    const audit = await runAuditChecks(
      target({ tos: { ...target().tos, status: "prohibited" } }),
      { runtimeMode: "REPLAY", runAudit: async () => { called = true; throw new Error("must not run"); } },
    );
    expect(called).toBe(false);
    expect(audit.checks).toHaveLength(1);
    expect(audit.checks[0]?.evidence).toContain("https://example.test/terms");
  });
});

describe("K checks", () => {
  it("covers every K1 robots outcome", () => {
    for (const kind of ["present", "not_found", "server_error", "unreachable", "BLOCKED_BY_WAF"] as const) {
      expect(checkK1(policy(kind)).outcome).toBe(kind);
    }
  });

  it("covers K2 allowed, limited, and disallowed", () => {
    expect(checkK2(policy("present"), ["https://example.test/a"]).outcome).toBe("allowed");
    expect(checkK2(policy("present", { crawlDelayMs: 1_000 }), ["https://example.test/a"]).outcome).toBe("allowed_with_limits");
    expect(checkK2(policy("present", { allowed: [false] }), ["https://example.test/a"]).outcome).toBe("disallowed");
  });

  it("covers K3 stated, partial, and silent using synthetic fixtures", () => {
    expect(checkK3(fixture.robots.stated).outcome).toBe("stated");
    expect(checkK3(fixture.robots.partial).outcome).toBe("partial");
    expect(checkK3(fixture.robots.silent).outcome).toBe("silent");
    expect(checkK3("", response(200, {}, "# llms.txt")).outcome).toBe("stated");
  });

  it("covers K4 none and declared-and-honored", () => {
    expect(checkK4(policy("present")).outcome).toBe("none");
    expect(checkK4(policy("present", { crawlDelayMs: 60_000 })).outcome).toBe("declared_and_honored");
  });
});

describe("D checks", () => {
  it("covers D1 reachable and not found", () => {
    expect(checkD1(response(200), catalog("machine")).outcome).toBe("reachable");
    expect(parseCatalog(JSON.stringify(fixture.catalogs.ckan), "ckan")).toHaveLength(1);
    expect(parseCatalog(JSON.stringify(fixture.catalogs.socrata), "socrata")).toHaveLength(1);
    expect(checkD1(response(404), []).outcome).toBe("not_found_in_sample");
  });

  it("covers every D2 license outcome and reports N", () => {
    expect(checkD2(catalog("machine")).outcome).toBe("url_or_spdx");
    expect(checkD2(catalog("spdxEmptyFuture")).evidence).toContain("URL or SPDX 1");
    expect(checkD2(catalog("proseShortStale")).outcome).toBe("prose");
    expect(checkD2(catalog("emptyTemplateImpossible")).outcome).toBe("empty_or_tbd");
    expect(checkD2([]).outcome).toBe("not_found_in_sample");
    expect(checkD2(catalog("machine")).evidence).toContain("N=1");
  });

  it("covers every D3 description outcome and reports N", () => {
    expect(checkD3(catalog("machine")).outcome).toBe("present");
    expect(checkD3(catalog("proseShortStale")).outcome).toBe("short");
    expect(checkD3(catalog("emptyTemplateImpossible")).outcome).toBe("empty_or_template");
    expect(checkD3(catalog("spdxEmptyFuture")).outcome).toBe("empty_or_template");
    expect(checkD3([]).outcome).toBe("not_found_in_sample");
    expect(checkD3(catalog("machine")).evidence).toContain("N=1");
  });

  it("covers every D4 date outcome and reports N", () => {
    const probe = new Date("2026-10-31T12:00:00Z");
    expect(checkD4(catalog("machine"), probe).outcome).toBe("sane");
    expect(checkD4(catalog("proseShortStale"), probe).outcome).toBe("stale");
    expect(checkD4(catalog("emptyTemplateImpossible"), probe).outcome).toBe("impossible");
    expect(checkD4(catalog("spdxEmptyFuture"), probe).outcome).toBe("impossible");
    expect(checkD4([], probe).outcome).toBe("not_found_in_sample");
    expect(checkD4(catalog("machine"), probe).evidence).toContain("N=1");
  });

  it("covers every D5 lane outcome", () => {
    expect(checkD5(response(200, { "content-type": "text/csv" })).outcome).toBe("api_or_bulk_endpoint");
    expect(checkD5(response(200, { "content-type": "text/html" })).outcome).toBe("landing_page_only");
    expect(checkD5(undefined).outcome).toBe("not_found_in_sample");
  });
});

describe("audit orchestration and grading", () => {
  it("reports the exact Boston robots rule and blocked catalog path from the recording", async () => {
    const boston = targets.find(({ alias }) => alias === "boston");
    if (boston === undefined) throw new Error("Boston target missing");
    const audit = await runAuditChecks(boston, new ReplayFetcher({ timeScale: 0 }));
    const k2 = audit.checks.find(({ id }) => id === "K2");
    expect(k2?.evidence).toContain("Blocked by robots.txt: Disallow: /api/");
    expect(k2?.evidence).toContain("path /api/3/action/package_search");
  });

  it("runs a three-request deep replay and returns every check", async () => {
    const body = JSON.stringify(fixture.catalogs.machine);
    const exchanges: AuditRecording["exchanges"] = [
      recorded("https://example.test/robots.txt", "GET", 200, "User-agent: *\nAllow: /"),
      recorded("https://example.test/data.json", "GET", 200, body, { "content-type": "application/json" }),
      recorded("https://example.test/data.csv", "HEAD", 200, "", { "content-type": "text/csv" }),
    ];
    const replay = new ReplayFetcher({
      recording: { schemaVersion: 1, alias: "synthetic", mode: "audit", recordedAt: "2026-10-31T12:00:00Z", exchanges },
      timeScale: 0,
    });
    const audit = await runAuditChecks(target(), replay, () => new Date("2026-10-31T12:00:00Z"));
    expect(audit.checks.map(({ id }) => id)).toEqual(["T0", "K1", "K2", "K3", "K4", "D1", "D2", "D3", "D4", "D5"]);
    expect(audit.sampledEntries).toBe(1);
    const grade = gradeAudit("audit", audit.checks, audit.sampledEntries, audit.probedOn);
    expect(grade.score).toBe(100);
    expect(grade.verdict).toContain("Sampled 1 | Probed 2026-10-31 | Rubric v1 | Not a ranking of agency quality");
  });

  it("does not let K3 silence or K4 change a Quick Knock grade", () => {
    const base = [
      checkK1(policy("present")),
      checkK2(policy("present"), ["https://example.test/llms.txt"]),
    ];
    const silent = gradeAudit("knock", [...base, checkK3(fixture.robots.silent), checkK4(policy("present"))], 0, "2026-10-31");
    const stated = gradeAudit("knock", [...base, checkK3(fixture.robots.stated), checkK4(policy("present", { crawlDelayMs: 1000 }))], 0, "2026-10-31");
    expect(silent.score).toBe(stated.score);
    expect(silent.verdict).toBe("Knock only: no catalog sampled | Probed 2026-10-31 | Rubric v1 | Not a ranking of agency quality");
  });
});

function recorded(
  url: string,
  method: "GET" | "HEAD",
  status: number,
  body: string,
  headers: Record<string, string> = {},
): AuditRecording["exchanges"][number] {
  return {
    url,
    method,
    status,
    headers,
    body: Buffer.from(body).toString("base64"),
    bodyEncoding: "base64",
    timestamp: "2026-10-31T12:00:00Z",
    ms: 5,
  };
}
