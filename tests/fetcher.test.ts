import { describe, expect, it } from "vitest";
import type { Target } from "../src/config.js";
import {
  FetcherError,
  LiveFetcher,
  MAX_RESPONSE_BYTES,
  ReplayFetcher,
  isPublicAddress,
  type AuditRecording,
  type FetchResponse,
  type LiveFetcherOptions,
  type Transport,
} from "../src/audit/fetcher.js";

function target(mode: "knock" | "audit" = "audit"): Target {
  return {
    alias: "synthetic",
    name: "Synthetic target",
    host: "example.test",
    mode,
    ...(mode === "audit" ? { catalogUrl: "https://example.test/data.json", dialect: "dcat" as const } : {}),
    tos: {
      status: "no-prohibition-found",
      sourceUrl: "https://example.test/terms",
      evidence: "Synthetic permission",
      reviewedOn: "2026-10-31",
    },
    tosReviewed: true,
    notes: "Synthetic only",
  };
}

function response(
  url: URL,
  method: "GET" | "HEAD",
  status = 200,
  body = "",
  headers: Record<string, string> = {},
): FetchResponse {
  return {
    url: url.toString(),
    method,
    status,
    headers,
    body: Buffer.from(body),
    timestamp: "2026-10-31T12:00:00Z",
    ms: 7,
  };
}

function live(
  transport: Transport,
  options: Partial<LiveFetcherOptions> = {},
): LiveFetcher {
  return new LiveFetcher({
    repoUrl: "https://github.com/example/agent-ready-live",
    contactEmail: "agent@example.test",
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    transport,
    allowlist: [target(), target("knock")],
    ...options,
  });
}

function sequence(
  items: Array<{ status?: number; body?: string | Buffer; headers?: Record<string, string> }>,
): Transport {
  let index = 0;
  return async ({ url, method }) => {
    const item = items[index++];
    if (item === undefined) throw new Error("Unexpected synthetic request");
    const result = response(url, method, item.status ?? 200, "", item.headers);
    return { ...result, body: Buffer.isBuffer(item.body) ? item.body : Buffer.from(item.body ?? "") };
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("SSRF and protocol guards", () => {
  it("refuses targets that do not exactly match the configured allowlist", async () => {
    const fetcher = live(sequence([]), { allowlist: [] });
    await expectCode(fetcher.runAudit(target(), (session) => session.robots()), "TARGET_NOT_ALLOWLISTED");
  });

  it("classifies private, loopback, link-local, ULA, and IPv4-mapped addresses as non-public", () => {
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:93.184.216.34",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("rejects a private DNS answer before transport", async () => {
    let transported = false;
    const fetcher = live(async () => {
      transported = true;
      throw new Error("must not run");
    }, { resolver: async () => [{ address: "127.0.0.1", family: 4 }] });
    await expectCode(fetcher.runAudit(target(), (session) => session.robots()), "PRIVATE_IP");
    expect(transported).toBe(false);
  });

  it("rejects a redirect to a non-allowlisted host before DNS or transport", async () => {
    let calls = 0;
    const fetcher = live(async ({ url, method }) => {
      calls += 1;
      if (url.pathname === "/robots.txt") return response(url, method, 200, "User-agent: *\nAllow: /");
      return response(url, method, 302, "", { location: "https://evil.test/escape" });
    });
    await expectCode(
      fetcher.runAudit(target(), async (session) => {
        await session.robots();
        return await session.request("https://example.test/data.json", "GET");
      }),
      "HOST_NOT_ALLOWLISTED",
    );
    expect(calls).toBe(2);
  });

  it("uses the resolved public address as the pinned transport address", async () => {
    const addresses: string[] = [];
    const fetcher = live(async (request) => {
      addresses.push(request.address.address);
      return response(request.url, request.method, 200, "User-agent: *\nAllow: /");
    });
    await fetcher.runAudit(target(), (session) => session.robots());
    expect(addresses).toEqual(["93.184.216.34"]);
  });
});

describe("budget, stop, robots, and body guards", () => {
  it("rejects an oversized streamed result", async () => {
    const fetcher = live(sequence([{ body: Buffer.alloc(MAX_RESPONSE_BYTES + 1) }]));
    await expectCode(fetcher.runAudit(target(), (session) => session.robots()), "RESPONSE_TOO_LARGE");
  });

  it("stops after a 429 and does not retry", async () => {
    let calls = 0;
    const transport = sequence([
      { body: "User-agent: *\nAllow: /" },
      { status: 429, body: "slow down" },
    ]);
    const fetcher = live(async (request) => {
      calls += 1;
      return await transport(request);
    });
    await fetcher.runAudit(target("knock"), async (session) => {
      await session.robots();
      expect((await session.request("https://example.test/llms.txt", "GET")).status).toBe(429);
      await expectCode(session.request("https://example.test/llms.txt", "GET"), "AUDIT_ALREADY_ENDED");
    });
    expect(calls).toBe(2);
  });

  it("enforces the deep audit request budget across all requests", async () => {
    const fetcher = live(sequence([
      { body: "User-agent: *\nAllow: /" },
      {},
      {},
    ]));
    await fetcher.runAudit(target(), async (session) => {
      await session.robots();
      await session.request("https://example.test/data.json", "GET");
      await session.request("https://example.test/one.csv", "HEAD");
      await expectCode(session.request("https://example.test/two.csv", "HEAD"), "BUDGET_EXCEEDED");
      expect(session.requestCount).toBe(3);
    });
  });

  it("honors a robots disallow without requesting the path", async () => {
    let calls = 0;
    const fetcher = live(async ({ url, method }) => {
      calls += 1;
      return response(url, method, 200, "User-agent: *\nDisallow: /data.json");
    });
    await fetcher.runAudit(target(), async (session) => {
      await session.robots();
      await expectCode(session.request("https://example.test/data.json", "GET"), "ROBOTS_DISALLOWED");
    });
    expect(calls).toBe(1);
  });

  it("treats robots 4xx as allowed, 5xx as full disallow, and WAF 403 separately", async () => {
    const four = live(sequence([{ status: 404 }]));
    expect((await four.runAudit(target(), (session) => session.robots())).kind).toBe("not_found");

    const five = live(sequence([{ status: 503 }]));
    const fivePolicy = await five.runAudit(target(), (session) => session.robots());
    expect(fivePolicy.kind).toBe("server_error");
    expect(fivePolicy.isAllowed("https://example.test/data.json")).toBe(false);

    const waf = live(sequence([{ status: 403, body: "Attention Required! Cloudflare Ray ID" }]));
    expect((await waf.runAudit(target(), (session) => session.robots())).kind).toBe("BLOCKED_BY_WAF");
  });
});

describe("events, replay timing, and serialization", () => {
  it("keeps same-host request concurrency at one within an audit", async () => {
    let active = 0;
    let maximum = 0;
    const fetcher = live(async ({ url, method }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return response(url, method, 200, url.pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : "");
    });
    await fetcher.runAudit(target(), async (session) => {
      await session.robots();
      await Promise.all([
        session.request("https://example.test/one", "GET"),
        session.request("https://example.test/two", "HEAD"),
      ]);
    });
    expect(maximum).toBe(1);
  });

  it("emits one request event per exchange and exposes Crawl-delay wait timing", async () => {
    const events: unknown[] = [];
    const waits: number[] = [];
    let now = 1_000;
    const fetcher = live(sequence([
      { body: "User-agent: *\nAllow: /\nCrawl-delay: 2" },
      {},
    ]), {
      now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; },
      onEvent: (event) => events.push(event),
    });
    await fetcher.runAudit(target("knock"), async (session) => {
      await session.robots();
      await session.request("https://example.test/llms.txt", "GET");
    });
    expect(waits).toEqual([2_000]);
    expect(events).toEqual([
      { type: "request", method: "GET", path: "/robots.txt", status: 200, ms: 7 },
      { type: "crawl-delay", host: "example.test", waitMs: 2_000, until: "1970-01-01T00:00:03.000Z" },
      { type: "request", method: "GET", path: "/llms.txt", status: 200, ms: 7 },
    ]);
  });

  it("scales Crawl-delay during replay", async () => {
    let now = 0;
    const waits: number[] = [];
    const recording: AuditRecording = {
      schemaVersion: 1,
      alias: "synthetic",
      mode: "knock",
      recordedAt: "2026-10-31T12:00:00Z",
      exchanges: [
        exchange("https://example.test/robots.txt", "GET", "User-agent: *\nAllow: /\nCrawl-delay: 10"),
        exchange("https://example.test/llms.txt", "GET", "# policy"),
      ],
    };
    const replay = new ReplayFetcher({
      recording,
      timeScale: 0.01,
      now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; },
    });
    await replay.runAudit(target("knock"), async (session) => {
      await session.robots();
      await session.request("https://example.test/llms.txt", "GET");
    });
    expect(waits).toEqual([100]);
  });

  it("serializes complete audits through the global queue", async () => {
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    let markFirstStarted = (): void => undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const first = live(async ({ url, method }) => {
      order.push("first-request");
      markFirstStarted();
      await gate;
      return response(url, method, 200, "User-agent: *\nAllow: /");
    });
    const second = live(async ({ url, method }) => {
      order.push("second-request");
      return response(url, method, 200, "User-agent: *\nAllow: /");
    });
    const firstRun = first.runAudit(target(), async (session) => {
      order.push("first-start");
      await session.robots();
      order.push("first-end");
    });
    const secondRun = second.runAudit(target(), async (session) => {
      order.push("second-start");
      await session.robots();
    });
    await firstStarted;
    expect(order).toEqual(["first-start", "first-request"]);
    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(["first-start", "first-request", "first-end", "second-start", "second-request"]);
  });
});

function exchange(
  url: string,
  method: "GET" | "HEAD",
  body: string,
): AuditRecording["exchanges"][number] {
  return {
    url,
    method,
    status: 200,
    headers: {},
    body: Buffer.from(body).toString("base64"),
    bodyEncoding: "base64",
    timestamp: "2026-10-31T12:00:00Z",
    ms: 1,
  };
}
