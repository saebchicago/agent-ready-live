import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dataGovV4CensusFromRecording,
  dataGovV4OrganizationsUrl,
  dataGovV4SearchUrl,
  formatDataGovV4National,
  formatDataGovV4Publisher,
} from "../src/audit/census-v4.js";
import { FetcherError, LiveFetcher, ReplayFetcher, type AuditRecording, type FetchResponse, type RecordedExchange } from "../src/audit/fetcher.js";
import { targets } from "../src/config.js";
import { redactApiKeyFromExchange } from "../scripts/record.js";

function recorded(url: string, value: unknown): RecordedExchange {
  return {
    url, method: "GET", status: 200, headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(value)).toString("base64"), bodyEncoding: "base64",
    timestamp: "2026-11-02T12:00:00.000Z", ms: 10,
  };
}

describe("Data.gov v4 census", () => {
  it("uses the configured v4 base and sampled search query", () => {
    const target = targets.find(({ alias }) => alias === "datagov-v4")!;
    expect(new URL(dataGovV4OrganizationsUrl(target)).pathname).toBe("/technology/datagov/v4/api/organizations");
    const search = new URL(dataGovV4SearchUrl(target, "new-york-city"));
    expect(search.pathname).toBe("/technology/datagov/v4/search");
    expect(search.searchParams.get("per_page")).toBe("100");
    expect(search.searchParams.get("org_slug")).toBe("new-york-city");
    expect([...search.searchParams.keys()]).toEqual(["per_page", "org_slug"]);
  });

  it("allows one robots request and at most six v4 API requests", async () => {
    const target = targets.find(({ alias }) => alias === "datagov-v4")!;
    const orgUrl = dataGovV4OrganizationsUrl(target);
    const searchUrl = dataGovV4SearchUrl(target, "detroit");
    const recording: AuditRecording = {
      schemaVersion: 1, alias: "datagov-v4", mode: "catalog-census-v4", recordedAt: "2026-11-02T12:00:00Z",
      exchanges: [
        { ...recorded("https://api.gsa.gov/robots.txt", {}), body: Buffer.from("User-agent: *\nAllow: /").toString("base64") },
        recorded(orgUrl, {}), ...Array.from({ length: 6 }, () => recorded(searchUrl, {})),
      ],
    };
    const replay = new ReplayFetcher({ recording, timeScale: 0 });
    await replay.runAudit(target, async (session) => {
      await session.robots();
      await session.request(orgUrl, "GET");
      for (let index = 0; index < 5; index += 1) await session.request(searchUrl, "GET");
      expect(session.requestCount).toBe(7);
      await expect(session.request(searchUrl, "GET")).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    });
  });

  it("derives publisher totals and type counts from organizations and sampled license shares from search records", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/synthetic/datagov-v4-responses.json"), "utf8")) as {
      organizations: unknown; search: unknown;
    };
    const target = targets.find(({ alias }) => alias === "datagov-v4")!;
    const searches = new Map<string, RecordedExchange>();
    for (const slug of ["michigan", "detroit", "chicago", "nyc", "boston"]) {
      searches.set(slug, recorded(dataGovV4SearchUrl(target, slug), fixture.search));
    }
    const recording: AuditRecording = {
      schemaVersion: 1, alias: "datagov-v4", mode: "catalog-census-v4", recordedAt: "2026-11-02T12:00:00.000Z",
      sanitized: ["set-cookie", "cookie"], exchanges: [recorded(dataGovV4OrganizationsUrl(target), fixture.organizations), ...searches.values()],
    };
    const census = dataGovV4CensusFromRecording(recording);
    expect(census.publishers).toBe(5);
    expect(census.datasets).toBe(780);
    expect(census.byType).toEqual({ Federal: 0, State: 100, City: 680, County: 0 });
    expect(census.publishersBySearch.find(({ queryTerm }) => queryTerm === "Detroit")).toMatchObject({
      datasetCount: 120, sampleCount: 3, licensedCount: 1, licenseShare: 1 / 3,
    });
    expect(formatDataGovV4National(census)).toBe(
      "5 publishers | 780 datasets | by type: Federal 0, State 100, City 680, County 0 | Probed 2026-11-02 | Not a ranking",
    );
    expect(formatDataGovV4Publisher(census, "Detroit")).toContain("Modeled: sample of 3 records");
  });

  it("reports a publisher absent from the organizations response as not in data.gov", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/synthetic/datagov-v4-responses.json"), "utf8")) as {
      organizationsMissingBoston: unknown; search: unknown;
    };
    const target = targets.find(({ alias }) => alias === "datagov-v4")!;
    const searches = new Map<string, RecordedExchange>();
    for (const slug of ["michigan", "detroit", "chicago", "nyc"]) {
      searches.set(slug, recorded(dataGovV4SearchUrl(target, slug), fixture.search));
    }
    const recording: AuditRecording = {
      schemaVersion: 1, alias: "datagov-v4", mode: "catalog-census-v4", recordedAt: "2026-11-02T12:00:00.000Z",
      exchanges: [recorded(dataGovV4OrganizationsUrl(target), fixture.organizationsMissingBoston), ...searches.values()],
    };
    const census = dataGovV4CensusFromRecording(recording);
    expect(census.notInDataGov).toContain("Boston");
    expect(formatDataGovV4Publisher(census, "Boston")).toContain("Boston not in data.gov");
  });

  it("sends the key only in X-Api-Key and removes it from the recorded fixture", async () => {
    const target = targets.find(({ alias }) => alias === "datagov-v4")!;
    const key = "synthetic-secret-key-123";
    const requests: Array<{ path: string; headers: Readonly<Record<string, string>> }> = [];
    const exchanges: RecordedExchange[] = [];
    const events: unknown[] = [];
    const fetcher = new LiveFetcher({
      repoUrl: "https://github.com/example/agent-ready-live",
      contactEmail: "agent@example.test",
      allowlist: [target],
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      onEvent: (event) => events.push(event),
      transport: async ({ url, method, headers }) => {
        requests.push({ path: url.pathname, headers });
        const body = url.pathname.endsWith("robots.txt") ? "User-agent: *\nAllow: /" : `{"echo":"${key}"}`;
        const response: FetchResponse = {
          url: url.toString(), method, status: 200,
          headers: { "content-type": url.pathname.endsWith("robots.txt") ? "text/plain" : "application/json", "x-echo": key },
          body: Buffer.from(body), timestamp: "2026-11-02T12:00:00Z", ms: 1,
        };
        return response;
      },
      onExchange: (exchange) => exchanges.push(redactApiKeyFromExchange(exchange, key)),
    });
    await fetcher.runAudit(target, async (session) => {
      await session.robots();
      await session.requestWithApiKey(dataGovV4OrganizationsUrl(target), key);
    });
    const robots = requests.find(({ path }) => path === "/robots.txt")!;
    const api = requests.find(({ path }) => path.endsWith("/api/organizations"))!;
    expect(Object.keys(robots.headers)).not.toContain("X-Api-Key");
    expect(api.headers["X-Api-Key"]).toBe(key);
    expect(JSON.stringify(events)).not.toContain(key);
    const fixtureText = JSON.stringify({ exchanges });
    expect(fixtureText).not.toContain(key);
    expect(fixtureText).not.toContain("requestHeaders");
    await expect(fetcher.runAudit(target, (session) =>
      session.requestWithApiKey(`https://${target.host}/outside-v4`, key),
    )).rejects.toMatchObject({ code: "API_KEY_TARGET_NOT_ALLOWED" });
  });

  it("blocks an API-key redirect outside the configured endpoint before another transport call", async () => {
    const target = targets.find(({ alias }) => alias === "datagov-v4")!;
    const transported: string[] = [];
    const fetcher = new LiveFetcher({
      repoUrl: "https://github.com/example/agent-ready-live",
      contactEmail: "agent@example.test",
      allowlist: [target],
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async ({ url, method }) => {
        transported.push(url.pathname);
        if (url.pathname === "/robots.txt") return {
          url: url.toString(), method, status: 200, headers: { "content-type": "text/plain" },
          body: Buffer.from("User-agent: *\\nAllow: /"), timestamp: "2026-11-02T12:00:00Z", ms: 1,
        };
        return {
          url: url.toString(), method, status: 302,
          headers: { location: "/technology/datagov/v4/unexpected" },
          body: Buffer.alloc(0), timestamp: "2026-11-02T12:00:00Z", ms: 1,
        };
      },
    });
    await expect(fetcher.runAudit(target, (session) =>
      session.requestWithApiKey(dataGovV4OrganizationsUrl(target), "synthetic-secret-key"),
    )).rejects.toMatchObject({ code: "API_KEY_REDIRECT_BLOCKED" });
    expect(transported).toEqual(["/robots.txt", "/technology/datagov/v4/api/organizations"]);
  });
});
