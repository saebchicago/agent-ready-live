import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveNationalCensus, formatPublisherForChat, censusRequestUrls } from "../src/audit/census.js";
import type { RecordedExchange } from "../src/audit/fetcher.js";
import { ReplayFetcher, type AuditRecording } from "../src/audit/fetcher.js";
import { targets } from "../src/config.js";

function exchange(url: string, value: unknown, truncated = false): RecordedExchange {
  return {
    url,
    method: "GET",
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(value)).toString("base64"),
    bodyEncoding: "base64",
    timestamp: "2026-11-02T12:00:00.000Z",
    ms: 12,
    ...(truncated ? { truncated: true } : {}),
  };
}

describe("Data.gov catalog census", () => {
  it("constructs only the two requested CKAN facet calls", () => {
    const target = targets.find(({ alias }) => alias === "datagov")!;
    const [a, b] = censusRequestUrls(target).map((raw) => new URL(raw)) as [URL, URL];
    expect(a.pathname).toBe("/api/3/action/package_search");
    expect(a.searchParams.get("rows")).toBe("1");
    expect(JSON.parse(a.searchParams.get("facet.field")!)).toEqual(["license_id", "organization", "res_format"]);
    expect(a.searchParams.get("facet.limit")).toBe("25");
    expect(b.searchParams.get("rows")).toBe("0");
    expect(JSON.parse(b.searchParams.get("facet.field")!)).toEqual(["organization"]);
    expect(b.searchParams.get("facet.limit")).toBe("-1");
  });

  it("replays robots plus the two facet calls within the census budget", async () => {
    const target = targets.find(({ alias }) => alias === "datagov")!;
    const [urlA, urlB] = censusRequestUrls(target);
    const recording: AuditRecording = {
      schemaVersion: 1,
      alias: "datagov",
      mode: "catalog-census",
      recordedAt: "2026-11-02T12:00:00.000Z",
      sanitized: ["set-cookie", "cookie"],
      exchanges: [
        {
          ...exchange("https://catalog.data.gov/robots.txt", {}),
          headers: { "content-type": "text/plain" },
          body: Buffer.from("User-agent: *\nCrawl-delay: 10\nDisallow:").toString("base64"),
        },
        exchange(urlA, { success: true, result: { count: 1, facets: {} } }),
        exchange(urlB, { success: true, result: { count: 1, facets: {} } }),
      ],
    };
    let now = 100;
    const fetcher = new ReplayFetcher({ recording, timeScale: 1, now: () => now, sleep: async (ms) => { now += ms; } });
    await fetcher.runAudit(target, async (session) => {
      const policy = await session.robots();
      expect(policy.crawlDelayMs).toBe(10_000);
      await session.request(urlA, "GET");
      await session.request(urlB, "GET");
      expect(session.requestCount).toBe(3);
      expect(now).toBeGreaterThanOrEqual(20_100);
    });
  });

  it("derives totals, license shares, no-license share, formats, and named publishers from synthetic facets", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/synthetic/catalog-census-facets.json"), "utf8")) as {
      callA: unknown; callB: unknown;
    };
    const [urlA, urlB] = censusRequestUrls(targets.find(({ alias }) => alias === "datagov")!);
    const census = deriveNationalCensus(exchange(urlA, fixture.callA), exchange(urlB, fixture.callB), "2026-11-02");
    expect(census.totalDatasets).toBe(100);
    expect(census.licenses.find(({ name }) => name === "cc0-1.0")).toMatchObject({ count: 30, share: 0.3 });
    expect(census.noLicenseCount).toBe(60);
    expect(census.noLicenseShare).toBe(0.6);
    expect(census.formats[0]).toMatchObject({ name: "CSV", count: 40 });
    expect(census.namedPublisherCounts).toMatchObject({ Michigan: 8, Detroit: 7, Boston: 6, "New York": 5, Chicago: 0 });
    expect(formatPublisherForChat(census, "Michigan")).toContain("Michigan Data: 8");
    expect(formatPublisherForChat(census, "Michigan")).toContain("Probed 2026-11-02 | Not a ranking");
  });

  it("reports missing facets as unavailable and marks Call B truncation", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/synthetic/catalog-census-facets.json"), "utf8")) as {
      missingFacet: unknown; callA: unknown; callB: unknown;
    };
    const [urlA, urlB] = censusRequestUrls(targets.find(({ alias }) => alias === "datagov")!);
    const missing = deriveNationalCensus(exchange(urlA, fixture.missingFacet), undefined, "2026-11-02");
    expect(missing.licenseFacetAvailable).toBe(true);
    expect(missing.formatsAvailable).toBe(false);
    expect(missing.publishersAvailable).toBe(false);
    expect(missing.notes.join(" ")).toContain("Format facet not available in this catalog.");
    expect(missing.notes.join(" ")).toContain("Publisher facet not available in this catalog.");
    const truncated = deriveNationalCensus(exchange(urlA, fixture.callA), exchange(urlB, fixture.callB, true), "2026-11-02", true);
    expect(truncated.truncated).toBe(true);
    expect(truncated.publishersAvailable).toBe(false);
    expect(truncated.notes.join(" ")).toContain("Call B was truncated at the 5 MB response cap.");
  });
});
