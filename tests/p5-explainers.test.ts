import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EXPLAINERS, getExplainer } from "../src/audit/explainers.js";
import { createFixItCard } from "../src/audit/fixit.js";
import { classifyDoorLadder, DOOR_LADDER, sideDoorLine } from "../src/audit/ladder.js";
import { targets } from "../src/config.js";
import type { AuditRecording } from "../src/audit/fetcher.js";
import type { Fetcher } from "../src/audit/fetcher.js";
import { ReplayFetcher } from "../src/audit/fetcher.js";
import { runAuditChecks } from "../src/audit/checks.js";
import type { CheckResult } from "../src/audit/checks.js";

const byAlias = (alias: string) => {
  const target = targets.find((item) => item.alias === alias);
  if (!target) throw new Error(`Missing ${alias}`);
  return target;
};

describe("P5 explanation cards and door ladder", () => {
  it("places every configured target on one of the five rungs", () => {
    const expected: Record<string, string> = {
      detroit: "Open with gaps", boston: "Closed by robots", nyc: "Open by law",
      chicago: "Closed by terms", wikipedia: "Open with gaps", michigan: "Closed by terms",
      twitch: "Closed by terms", samgov: "Closed by terms",
      datagov: "Open with gaps", "arcgis-hub": "Closed by terms",
      "datagov-v4": "Open with gaps",
      "census-wayne": "Open with gaps",
    };
    expect(DOOR_LADDER).toHaveLength(5);
    for (const target of targets) {
      const checks: CheckResult[] = target.tos.status === "prohibited"
        ? [{ id: "T0", outcome: "DOOR_CLOSED_BY_TERMS", evidence: target.tos.evidence, label: "Verified" }]
        : target.tosReviewed ? [{ id: "T0", outcome: "TERMS_GATE_OPEN", evidence: "reviewed", label: "Verified" }] : [{ id: "T0", outcome: "TERMS_NOT_REVIEWED", evidence: "incomplete", label: "Verified" }];
      if (target.alias === "boston") checks.push({ id: "K2", outcome: "disallowed", evidence: "Blocked by robots.txt: Disallow: /api/ (path /api/)", label: "Verified" });
      expect(classifyDoorLadder(target, checks).step).toBe(expected[target.alias]);
    }
  });

  it("formats side-door display copy and retains supplied Boston rule", async () => {
    expect(sideDoorLine("City of Boston Open Context MCP server")).toBe("Front door closed. Side door: City of Boston Open Context MCP server.");
    const fixture = JSON.parse(await readFile(resolve("fixtures/recorded/boston-2026-11-01.json"), "utf8")) as AuditRecording;
    const robots = fixture.exchanges.find((exchange) => exchange.url.endsWith("/robots.txt"));
    expect(robots).toBeDefined();
    const body = Buffer.from(robots!.body, robots!.bodyEncoding).toString("utf8");
    expect(body).toContain("Disallow: /api/");
    const audit = await runAuditChecks(byAlias("boston"), new ReplayFetcher({ recording: fixture, timeScale: 0 }));
    const k2 = audit.checks.find(({ id }) => id === "K2");
    expect(k2?.evidence).toContain("Blocked by robots.txt: Disallow: /api/");
    expect(k2?.evidence).toContain("path /api/");
  });

  it("keeps SAM.gov and ArcGIS Hub on T0 with zero fetcher calls", async () => {
    let calls = 0;
    const fetcher = { runtimeMode: "REPLAY", runAudit: async () => { calls += 1; throw new Error("must not run"); } } as unknown as Fetcher;
    const result = await runAuditChecks(byAlias("samgov"), fetcher);
    expect(result.checks.map(({ id, outcome }) => [id, outcome])).toEqual([["T0", "DOOR_CLOSED_BY_TERMS"]]);
    expect(calls).toBe(0);
    const arcgis = await runAuditChecks(byAlias("arcgis-hub"), fetcher);
    expect(arcgis.checks.map(({ id, outcome }) => [id, outcome])).toEqual([["T0", "DOOR_CLOSED_BY_TERMS"]]);
    expect(calls).toBe(0);
  });

  it("has a concise card for every check outcome", () => {
    for (const [id, outcomes] of Object.entries(EXPLAINERS)) {
      for (const outcome of Object.keys(outcomes)) {
        const card = getExplainer(id as CheckResult["id"], outcome);
        for (const line of [card.what, card.fix, card.standard]) expect(line.length).toBeLessThan(90);
      }
    }
  });

  it("builds fix-it values only from recorded Detroit fixture fields", async () => {
    const recording = JSON.parse(await readFile(resolve("fixtures/recorded/detroit-2026-11-01.json"), "utf8")) as AuditRecording;
    const checks: CheckResult[] = [
      { id: "D2", outcome: "empty_or_tbd", evidence: "", label: "Verified" },
      { id: "D3", outcome: "empty_or_template", evidence: "", label: "Verified" },
      { id: "D4", outcome: "stale", evidence: "", label: "Verified" },
    ];
    const card = createFixItCard(byAlias("detroit"), recording, checks);
    expect(card).toBeDefined();
    expect(card?.fields.map((field) => field.field)).toEqual(["license", "description", "date"]);
    const catalog = recording.exchanges.find((item) => item.url === byAlias("detroit").catalogUrl)!;
    const body = Buffer.from(catalog.body, catalog.bodyEncoding).toString("utf8");
    for (const { before } of card!.fields) {
      if (before !== "(field absent)" && before !== '""') expect(body).toContain(before);
    }
    expect(card?.fields.every(({ after }) => !/\b(?:MIT|CC-BY|https?:\/\/)/u.test(after))).toBe(true);
  });
});
