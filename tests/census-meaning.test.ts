import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CENSUS_API_PATH, CENSUS_NOTICE, censusMeaningFromExchange, censusMeaningUrl, deriveCensusMeaning, formatCensusTrap } from "../src/audit/census-meaning.js";
import { FetcherError, LiveFetcher, ReplayFetcher, type AuditRecording, type FetchResponse, type RecordedExchange } from "../src/audit/fetcher.js";
import { targets } from "../src/config.js";
import { redactApiKeyFromExchange } from "../scripts/record.js";

const target = targets.find(({ alias }) => alias === "census-wayne")!;
const key = "synthetic-census-key-78231";

function exchange(url: string, body: unknown): RecordedExchange {
  return {
    url, method: "GET", status: 200, headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)).toString("base64"), bodyEncoding: "base64",
    timestamp: "2026-11-02T12:00:00.000Z", ms: 9,
  };
}

describe("Census meaning check", () => {
  it("uses the configured ACS 5-year 2024 request for Wayne County tracts", () => {
    const url = new URL(censusMeaningUrl(target));
    expect(url.hostname).toBe("api.census.gov");
    expect(url.pathname).toBe(CENSUS_API_PATH);
    expect(url.searchParams.get("get")).toBe("NAME,B19013_001E,B19013_001M,B11001_001E");
    expect(url.searchParams.get("for")).toBe("tract:*");
    expect(url.searchParams.get("in")).toBe("state:26 county:163");
    expect(url.searchParams.has("key")).toBe(false);
  });

  it("treats all six Census sentinel values as missing with a reason and compares naive and corrected lists", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/synthetic/census-wayne-response.json"), "utf8")) as { rows: unknown[][] };
    const result = deriveCensusMeaning(fixture.rows, "2026-11-02", "synthetic");
    const sentinelRows = result.tracts.filter(({ errorReasons }) => errorReasons.length > 0);
    expect(sentinelRows).toHaveLength(2);
    expect(sentinelRows.flatMap(({ errorReasons }) => errorReasons).join(" "))
      .toContain("-666666666");
    expect(sentinelRows.flatMap(({ errorReasons }) => errorReasons).join(" "))
      .toContain("-999999999");
    expect(sentinelRows.flatMap(({ errorReasons }) => errorReasons).join(" "))
      .toContain("-888888888");
    expect(sentinelRows.flatMap(({ errorReasons }) => errorReasons).join(" "))
      .toContain("-555555555");
    expect(sentinelRows.flatMap(({ errorReasons }) => errorReasons).join(" "))
      .toContain("-333333333");
    expect(sentinelRows.flatMap(({ errorReasons }) => errorReasons).join(" "))
      .toContain("-222222222");
    expect(result.naiveLowest[0]?.rawIncome).toBe(-666666666);
    expect(result.correctedLowest[0]).toMatchObject({ income: 33000, marginOfError: 800 });
    const trap = formatCensusTrap(result);
    expect(trap).toContain("Naive agent's 10 lowest-income tracts");
    expect(trap).toContain("Corrected list");
    expect(trap).toContain("2 of 14 tracts return an error code");
    expect(trap).toContain(CENSUS_NOTICE);
    expect(trap.length).toBeLessThanOrEqual(450);
  });

  it("sends the key only on the Census query, hides it from ticker events and recorded fixtures, and stops at budget", async () => {
    const events: unknown[] = [];
    const fixtures: RecordedExchange[] = [];
    let apiCalls = 0;
    const fetcher = new LiveFetcher({
      repoUrl: "https://github.com/example/agent-ready-live", contactEmail: "agent@example.test", allowlist: [target],
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      onEvent: (event) => events.push(event),
      transport: async ({ url, method }) => {
        if (url.pathname !== "/robots.txt") {
          apiCalls += 1;
          expect(url.searchParams.get("key")).toBe(key);
        }
        const payload = url.pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : JSON.stringify([["NAME"], [key]]);
        return {
          url: url.toString(), method, status: 200, headers: { "content-type": "application/json", "x-echo": key },
          body: Buffer.from(payload), timestamp: "2026-11-02T12:00:00.000Z", ms: 9,
        } satisfies FetchResponse;
      },
      onExchange: (item) => fixtures.push(redactApiKeyFromExchange(item, key)),
    });
    await fetcher.runAudit(target, async (session) => {
      await session.robots();
      await session.requestWithCensusKey(censusMeaningUrl(target), key);
      await expect(session.requestWithCensusKey(censusMeaningUrl(target), key)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    });
    expect(apiCalls).toBe(1);
    const serialized = JSON.stringify(fixtures);
    expect(serialized).not.toContain(key);
    expect(JSON.stringify(events)).not.toContain(key);
    expect(fixtures[1]?.url).not.toContain("key=");
  });

  it("replays a keyless fixture while accepting the runtime key only ephemerally", async () => {
    const url = censusMeaningUrl(target);
    const rows = [["NAME", "B19013_001E", "B19013_001M", "B11001_001E", "state", "county", "tract"], ["Wayne", "50000", "1000", "300", "26", "163", "000100"]];
    const recording: AuditRecording = {
      schemaVersion: 1, alias: "census-wayne", mode: "meaning", recordedAt: "2026-11-02T12:00:00.000Z",
      exchanges: [exchange("https://api.census.gov/robots.txt", "User-agent: *\nAllow: /"), exchange(url, rows)],
    };
    const replay = new ReplayFetcher({ recording, timeScale: 0 });
    const response = await replay.runAudit(target, async (session) => {
      await session.robots();
      return await session.requestWithCensusKey(url, key);
    });
    expect(response.url).toBe(url);
    expect(response.url).not.toContain(key);
    expect(censusMeaningFromExchange(recording.exchanges[1])?.correctedLowest[0]?.income).toBe(50000);
  });

  it("rejects any Census API key URL outside the exact configured query", async () => {
    const fetcher = new LiveFetcher({
      repoUrl: "https://github.com/example/agent-ready-live", contactEmail: "agent@example.test", allowlist: [target],
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => { throw new Error("unexpected transport"); },
    });
    await expect(fetcher.runAudit(target, (session) => session.requestWithCensusKey("https://api.census.gov/data/2024/acs/acs5?get=NAME", key)))
      .rejects.toMatchObject({ code: "API_KEY_TARGET_NOT_ALLOWED" } satisfies Partial<FetcherError>);
  });
});
