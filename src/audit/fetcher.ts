import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { targets as configuredTargets, type Target, type TargetMode } from "../config.js";
import robotsParser from "robots-parser";

interface ParsedRobots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getMatchingLineNumber(url: string, userAgent?: string): number | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
}

const parseRobots = robotsParser as unknown as (
  url: string,
  contents: string,
) => ParsedRobots;

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const ROBOT_USER_AGENT = "AgentReadyLive/0.1";

export type HttpMethod = "GET" | "HEAD";
export type FetchErrorCode =
  | "AUDIT_ALREADY_ENDED"
  | "API_KEY_TARGET_NOT_ALLOWED"
  | "API_KEY_REDIRECT_BLOCKED"
  | "BLOCKED_BY_WAF"
  | "BUDGET_EXCEEDED"
  | "HOST_NOT_ALLOWLISTED"
  | "INVALID_PORT"
  | "METHOD_NOT_ALLOWED"
  | "NETWORK_ERROR"
  | "PRIVATE_IP"
  | "REPLAY_MISMATCH"
  | "RESPONSE_TOO_LARGE"
  | "ROBOTS_DISALLOWED"
  | "TARGET_NOT_REVIEWED"
  | "TARGET_NOT_ALLOWLISTED"
  | "TERMS_PROHIBITED"
  | "TIMEOUT";

export class FetcherError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    options?: ErrorOptions,
    readonly partialResponse?: FetchResponse,
  ) {
    super(message, options);
    this.name = "FetcherError";
  }
}

export interface RequestTickerEvent {
  type: "request";
  method: HttpMethod;
  path: string;
  status: number | "UNREACHABLE";
  ms: number;
  errorCode?: string;
}

export interface CrawlDelayEvent {
  type: "crawl-delay";
  host: string;
  waitMs: number;
  until: string;
}

export type FetcherEvent = RequestTickerEvent | CrawlDelayEvent;

export interface FetchResponse {
  url: string;
  method: HttpMethod;
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  timestamp: string;
  ms: number;
}

export type RobotsKind =
  | "present"
  | "not_found"
  | "server_error"
  | "unreachable"
  | "BLOCKED_BY_WAF";

export interface RobotsPolicy {
  kind: RobotsKind;
  status?: number;
  text: string;
  crawlDelayMs: number;
  stopped: boolean;
  isAllowed(url: string): boolean;
  matchingLine(url: string): number;
}

export interface AuditSession {
  readonly mode: TargetMode;
  readonly budget: number;
  readonly requestCount: number;
  robots(): Promise<RobotsPolicy>;
  request(url: string | URL, method: HttpMethod): Promise<FetchResponse>;
  requestWithApiKey(url: string | URL, key: string): Promise<FetchResponse>;
}

export interface Fetcher {
  readonly runtimeMode: "LIVE" | "REPLAY";
  runAudit<T>(
    target: Target,
    operation: (session: AuditSession) => Promise<T>,
  ): Promise<T>;
}

export interface RecordedExchange {
  url: string;
  method: HttpMethod;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "base64";
  timestamp: string;
  ms: number;
  truncated?: boolean;
}

export interface AuditRecording {
  schemaVersion: 1;
  alias: string;
  mode: TargetMode;
  recordedAt: string;
  sanitized?: ["set-cookie", "cookie"];
  exchanges: RecordedExchange[];
  censusError?: string;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface TransportRequest {
  url: URL;
  method: HttpMethod;
  headers: Readonly<Record<string, string>>;
  address: ResolvedAddress;
  timeoutMs: number;
  maxBytes: number;
}

export type Transport = (request: TransportRequest) => Promise<FetchResponse>;
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface LiveFetcherOptions {
  repoUrl: string;
  contactEmail: string;
  onEvent?: (event: FetcherEvent) => void;
  onExchange?: (exchange: RecordedExchange) => void;
  resolver?: Resolver;
  transport?: Transport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  allowlist?: readonly Target[];
}

interface SessionBackend {
  next(url: URL, method: HttpMethod, headers?: Readonly<Record<string, string>>): Promise<FetchResponse>;
}

interface SessionOptions {
  target: Target;
  backend: SessionBackend;
  onEvent: (event: FetcherEvent) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeScale: number;
  onExchange?: (exchange: RecordedExchange) => void;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const STOP_STATUSES = new Set([429, 503]);
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function budgetFor(mode: TargetMode): number {
  if (mode === "knock") return 2;
  if (mode === "catalog-census-v4") return 7;
  if (mode === "catalog-census") return 3;
  return 3;
}

function responseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function recorded(response: FetchResponse, truncated = false): RecordedExchange {
  const headers = Object.fromEntries(
    Object.entries(response.headers).filter(([name]) => !["cookie", "set-cookie"].includes(name.toLowerCase())),
  );
  return {
    url: response.url,
    method: response.method,
    status: response.status,
    headers,
    body: Buffer.from(response.body).toString("base64"),
    bodyEncoding: "base64",
    timestamp: response.timestamp,
    ms: response.ms,
    ...(truncated ? { truncated: true } : {}),
  };
}

function isFirewallPage(response: FetchResponse): boolean {
  if (response.status !== 403) return false;
  const headers = response.headers;
  if (headers["cf-ray"] !== undefined || headers["x-sucuri-block"] !== undefined) return true;
  const text = Buffer.from(response.body).toString("utf8").slice(0, 32_768).toLowerCase();
  return [
    "attention required",
    "web application firewall",
    "request blocked",
    "access denied",
    "bot detection",
    "verify you are human",
    "cloudflare ray id",
  ].some((marker) => text.includes(marker));
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function assertAllowedUrl(url: URL, target: Target): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetcherError("INVALID_PORT", `Unsupported protocol ${url.protocol}`);
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") {
    throw new FetcherError("INVALID_PORT", `Port ${port} is not allowed`);
  }
  if (normalizedHostname(url) !== target.host) {
    throw new FetcherError(
      "HOST_NOT_ALLOWLISTED",
      `Host ${normalizedHostname(url)} is not allowlisted for ${target.alias}`,
    );
  }
  if (url.username || url.password) {
    throw new FetcherError("HOST_NOT_ALLOWLISTED", "URLs with credentials are not allowed");
  }
}

function ipv4Octets(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").map(Number);
}

export function isPublicAddress(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets !== undefined) {
    const [a = 0, b = 0] = octets;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return false;
    }
    return true;
  }

  if (isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  if (value.includes(".")) return false;
  if (value === "::" || value === "::1" || value.startsWith("::ffff:")) return false;
  const first = Number.parseInt(value.split(":", 1)[0] ?? "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  return true;
}

const defaultResolver: Resolver = async (hostname) => {
  if (isIP(hostname) !== 0) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

/** A single-address DNS lookup that supports both Node lookup callback forms. */
export function createPinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    // Validate at the point of connection as well as when DNS is initially resolved.
    if (!isPublicAddress(address.address)) {
      throw new FetcherError("PRIVATE_IP", `Resolved address ${address.address} is not public`);
    }
    if (typeof options === "object" && options.all) {
      (callback as (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(
        null,
        [{ address: address.address, family: address.family }],
      );
      return;
    }
    (callback as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(
      null,
      address.address,
      address.family,
    );
  };
}

export const nodeTransport: Transport = async (input) => {
  const started = Date.now();
  const requester = input.url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<FetchResponse>((resolveResponse, rejectResponse) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: FetcherError): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      rejectResponse(error);
    };
    const request = requester(
      input.url,
      {
        method: input.method,
        headers: input.headers,
        servername: normalizedHostname(input.url),
        lookup: createPinnedLookup(input.address),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = input.maxBytes - bytes;
          if (buffer.byteLength > remaining) {
            if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
            bytes = input.maxBytes;
            const partialResponse: FetchResponse = {
              url: input.url.toString(),
              method: input.method,
              status: incoming.statusCode ?? 0,
              headers: responseHeaders(incoming.headers),
              body: Buffer.concat(chunks),
              timestamp: new Date().toISOString(),
              ms: Date.now() - started,
            };
            request.destroy();
            fail(
              new FetcherError(
                "RESPONSE_TOO_LARGE",
                `Response exceeded ${input.maxBytes} bytes`,
                undefined,
                partialResponse,
              ),
            );
            return;
          }
          bytes += buffer.byteLength;
          chunks.push(buffer);
        });
        incoming.once("end", () => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) clearTimeout(timeout);
          resolveResponse({
            url: input.url.toString(),
            method: input.method,
            status: incoming.statusCode ?? 0,
            headers: responseHeaders(incoming.headers),
            body: Buffer.concat(chunks),
            timestamp: new Date().toISOString(),
            ms: Date.now() - started,
          });
        });
        incoming.once("error", (error) => {
          fail(new FetcherError("NETWORK_ERROR", "Response stream failed", { cause: error }));
        });
      },
    );
    timeout = setTimeout(() => {
      request.destroy();
      fail(new FetcherError("TIMEOUT", `Request timed out after ${input.timeoutMs} ms`));
    }, input.timeoutMs);
    request.once("error", (error: NodeJS.ErrnoException) => {
      fail(new FetcherError("NETWORK_ERROR", `Network request failed (${error.code ?? "unknown"})`, { cause: error }));
    });
    request.end();
  });
};

async function resolveBeforeDeadline(
  resolver: Resolver,
  hostname: string,
  timeoutMs: number,
): Promise<readonly ResolvedAddress[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(hostname),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new FetcherError("TIMEOUT", `DNS resolution timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function buildPolicy(response: FetchResponse | undefined, networkError = false): RobotsPolicy {
  if (networkError || response === undefined) {
    return {
      kind: "unreachable",
      text: "",
      crawlDelayMs: 0,
      stopped: true,
      isAllowed: () => false,
      matchingLine: () => -1,
    };
  }
  const text = Buffer.from(response.body).toString("utf8");
  if (isFirewallPage(response)) {
    return {
      kind: "BLOCKED_BY_WAF",
      status: response.status,
      text,
      crawlDelayMs: 0,
      stopped: true,
      isAllowed: () => false,
      matchingLine: () => -1,
    };
  }
  if (response.status >= 500) {
    return {
      kind: "server_error",
      status: response.status,
      text,
      crawlDelayMs: 0,
      stopped: true,
      isAllowed: () => false,
      matchingLine: () => -1,
    };
  }
  if (response.status >= 400) {
    return {
      kind: "not_found",
      status: response.status,
      text,
      crawlDelayMs: 0,
      stopped: STOP_STATUSES.has(response.status),
      isAllowed: () => true,
      matchingLine: () => -1,
    };
  }

  const parser = parseRobots(response.url, text);
  const crawlDelaySeconds = parser.getCrawlDelay(ROBOT_USER_AGENT);
  return {
    kind: "present",
    status: response.status,
    text,
    crawlDelayMs:
      typeof crawlDelaySeconds === "number" && Number.isFinite(crawlDelaySeconds)
        ? Math.max(0, crawlDelaySeconds * 1_000)
        : 0,
    stopped: false,
    isAllowed: (url) => parser.isAllowed(url, ROBOT_USER_AGENT) !== false,
    matchingLine: (url) => parser.getMatchingLineNumber(url, ROBOT_USER_AGENT) ?? -1,
  };
}

class GuardedSession implements AuditSession {
  readonly budget: number;
  private count = 0;
  private policy: RobotsPolicy | undefined;
  private policyPromise: Promise<RobotsPolicy> | undefined;
  private lastRequestFinishedAtByHost = new Map<string, number>();
  private ended = false;
  private requestTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionOptions) {
    this.budget = budgetFor(options.target.mode);
  }

  get mode(): TargetMode {
    return this.options.target.mode;
  }

  get requestCount(): number {
    return this.count;
  }

  async robots(): Promise<RobotsPolicy> {
    this.policyPromise ??= this.loadRobots();
    return await this.policyPromise;
  }

  async request(input: string | URL, method: HttpMethod): Promise<FetchResponse> {
    return await this.requestWithHeaders(input, method, {});
  }

  async requestWithApiKey(input: string | URL, key: string): Promise<FetchResponse> {
    const target = this.options.target;
    const url = input instanceof URL ? new URL(input) : new URL(input);
    if (
      target.alias !== "datagov-v4" || target.host !== "api.gsa.gov" ||
      target.mode !== "catalog-census-v4" || url.hostname !== target.host ||
      !["/technology/datagov/v4/api/organizations", "/technology/datagov/v4/search"].includes(url.pathname) ||
      key.trim().length === 0
    ) {
      throw new FetcherError("API_KEY_TARGET_NOT_ALLOWED", "API key requests are restricted to configured Data.gov v4 endpoints");
    }
    return await this.requestWithHeaders(url, "GET", { "X-Api-Key": key });
  }

  private async requestWithHeaders(
    input: string | URL,
    method: HttpMethod,
    headers: Readonly<Record<string, string>>,
  ): Promise<FetchResponse> {
    if (method !== "GET" && method !== "HEAD") {
      throw new FetcherError("METHOD_NOT_ALLOWED", `Method ${String(method)} is not allowed`);
    }
    if (this.ended) {
      throw new FetcherError("AUDIT_ALREADY_ENDED", "The audit stopped after a terminal response");
    }
    const policy = await this.robots();
    if (policy.stopped) {
      throw new FetcherError(
        policy.kind === "BLOCKED_BY_WAF" ? "BLOCKED_BY_WAF" : "ROBOTS_DISALLOWED",
        `robots.txt policy stopped the audit (${policy.kind})`,
      );
    }
    const url = input instanceof URL ? new URL(input) : new URL(input);
    assertAllowedUrl(url, this.options.target);
    if (!policy.isAllowed(url.toString())) {
      this.ended = true;
      throw new FetcherError("ROBOTS_DISALLOWED", `robots.txt disallows ${url.pathname}`);
    }
    return await this.serialRequest(() => this.follow(url, method, false, headers));
  }

  private async serialRequest<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.requestTail;
    let release = (): void => undefined;
    this.requestTail = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async loadRobots(): Promise<RobotsPolicy> {
    const url = new URL(`https://${this.options.target.host}/robots.txt`);
    try {
      const response = await this.follow(url, "GET", true);
      this.policy = buildPolicy(response);
    } catch (error) {
      if (
        error instanceof FetcherError &&
        (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT")
      ) {
        this.policy = buildPolicy(undefined, true);
      } else {
        throw error;
      }
    }
    if (this.policy.stopped) this.ended = true;
    return this.policy;
  }

  private async follow(
    initialUrl: URL,
    method: HttpMethod,
    retrievingRobots: boolean,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<FetchResponse> {
    if (!retrievingRobots && this.ended) {
      throw new FetcherError("AUDIT_ALREADY_ENDED", "The audit stopped after a terminal response");
    }
    let url = new URL(initialUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      assertAllowedUrl(url, this.options.target);
      if ("X-Api-Key" in headers && (
        url.origin !== initialUrl.origin || url.pathname !== initialUrl.pathname ||
        this.options.target.alias !== "datagov-v4" || this.options.target.host !== "api.gsa.gov"
      )) {
        throw new FetcherError("API_KEY_REDIRECT_BLOCKED", "API key redirect left the configured Data.gov endpoint");
      }
      if (!retrievingRobots && this.policy !== undefined && !this.policy.isAllowed(url.toString())) {
        this.ended = true;
        throw new FetcherError("ROBOTS_DISALLOWED", `robots.txt disallows ${url.pathname}`);
      }
      if (this.count >= this.budget) {
        this.ended = true;
        throw new FetcherError(
          "BUDGET_EXCEEDED",
          `${this.mode} request budget of ${this.budget} was exhausted`,
        );
      }
      await this.waitForHost(url);
      this.count += 1;
      let response: FetchResponse;
      const started = this.options.now();
      try {
        response = await this.options.backend.next(url, method, headers);
      } catch (error) {
        if (error instanceof FetcherError && error.partialResponse !== undefined) {
          this.options.onExchange?.(recorded(error.partialResponse, true));
        }
        const cause = error instanceof Error ? error.cause : undefined;
        const errorWithCode = typeof error === "object" && error !== null && "code" in error ? error : undefined;
        const codedCause = typeof cause === "object" && cause !== null && "code" in cause ? cause : undefined;
        const underlyingCode = codedCause !== undefined
          ? String(codedCause.code)
          : errorWithCode !== undefined
            ? String(errorWithCode.code)
            : undefined;
        const errorCode = underlyingCode ?? (error instanceof FetcherError ? error.code : "NETWORK_ERROR");
        this.options.onEvent({
          type: "request",
          method,
          path: `${url.pathname}${url.search}`,
          status: error instanceof FetcherError && error.partialResponse !== undefined
            ? error.partialResponse.status
            : "UNREACHABLE",
          ms: Math.max(0, this.options.now() - started),
          errorCode,
        });
        this.lastRequestFinishedAtByHost.set(url.hostname, this.options.now());
        throw error;
      }
      this.options.onEvent({
        type: "request",
        method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        ms: response.ms,
      });
      this.lastRequestFinishedAtByHost.set(url.hostname, this.options.now());

      if (!REDIRECT_STATUSES.has(response.status)) {
        if (!retrievingRobots && response.status >= 400) this.ended = true;
        return response;
      }
      const location = response.headers.location;
      if (location === undefined || redirects === 3) return response;
      url = new URL(location, url);
    }
    throw new Error("Unreachable redirect state");
  }

  private async waitForHost(url: URL): Promise<void> {
    const crawlDelayMs = (this.policy?.crawlDelayMs ?? 0) * this.options.timeScale;
    const lastFinishedAt = this.lastRequestFinishedAtByHost.get(url.hostname);
    if (lastFinishedAt === undefined || crawlDelayMs <= 0) return;
    const waitMs = Math.max(0, Math.ceil(lastFinishedAt + crawlDelayMs - this.options.now()));
    if (waitMs === 0) return;
    this.options.onEvent({
      type: "crawl-delay",
      host: url.hostname,
      waitMs,
      until: new Date(this.options.now() + waitMs).toISOString(),
    });
    await this.options.sleep(waitMs);
  }
}

let globalAuditTail: Promise<void> = Promise.resolve();

async function queued<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globalAuditTail;
  let release = (): void => undefined;
  globalAuditTail = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export class LiveFetcher implements Fetcher {
  readonly runtimeMode = "LIVE" as const;
  private readonly resolver: Resolver;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onEvent: (event: FetcherEvent) => void;
  private readonly userAgent: string;
  private readonly allowlist: readonly Target[];

  constructor(private readonly options: LiveFetcherOptions) {
    const repo = new URL(options.repoUrl);
    if (repo.protocol !== "https:") throw new Error("repoUrl must use HTTPS");
    if (!/^\S+@\S+\.\S+$/.test(options.contactEmail)) {
      throw new Error("contactEmail must be a monitored email address");
    }
    this.userAgent = `${ROBOT_USER_AGENT} (+${repo.toString()}; contact: ${options.contactEmail})`;
    this.resolver = options.resolver ?? defaultResolver;
    this.transport = options.transport ?? nodeTransport;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.allowlist = options.allowlist ?? configuredTargets;
  }

  async runAudit<T>(
    target: Target,
    operation: (session: AuditSession) => Promise<T>,
  ): Promise<T> {
    return await queued(async () => {
      assertTargetAllowlisted(target, this.allowlist);
      assertTargetEligible(target);
      const backend: SessionBackend = {
        next: async (url, method, requestHeaders = {}) => {
          const started = Date.now();
          const addresses = await resolveBeforeDeadline(
            this.resolver,
            normalizedHostname(url),
            REQUEST_TIMEOUT_MS,
          );
          if (addresses.length === 0) {
            throw new FetcherError("NETWORK_ERROR", `DNS returned no addresses for ${url.hostname}`);
          }
          if (addresses.some(({ address }) => !isPublicAddress(address))) {
            throw new FetcherError("PRIVATE_IP", `DNS returned a non-public address for ${url.hostname}`);
          }
          const address = addresses[0];
          if (address === undefined) throw new FetcherError("NETWORK_ERROR", "DNS returned no address");
          const remainingMs = REQUEST_TIMEOUT_MS - (Date.now() - started);
          if (remainingMs <= 0) {
            throw new FetcherError("TIMEOUT", `Request timed out after ${REQUEST_TIMEOUT_MS} ms`);
          }
          const response = await this.transport({
            url,
            method,
            headers: { "user-agent": this.userAgent, accept: "*/*", ...requestHeaders },
            address,
            timeoutMs: remainingMs,
            maxBytes: MAX_RESPONSE_BYTES,
          });
          if (response.body.byteLength > MAX_RESPONSE_BYTES) {
            throw new FetcherError(
              "RESPONSE_TOO_LARGE",
              `Response exceeded ${MAX_RESPONSE_BYTES} bytes`,
            );
          }
          this.options.onExchange?.(recorded(response));
          return response;
        },
      };
      return await operation(
        new GuardedSession({
          target,
          backend,
          onEvent: this.onEvent,
          now: this.now,
          sleep: this.sleep,
          timeScale: 1,
          ...(this.options.onExchange === undefined ? {} : { onExchange: this.options.onExchange }),
        }),
      );
    });
  }
}

export interface ReplayFetcherOptions {
  fixturesDir?: string;
  timeScale?: number;
  onEvent?: (event: FetcherEvent) => void;
  recording?: AuditRecording;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ReplayFetcher implements Fetcher {
  readonly runtimeMode = "REPLAY" as const;
  private readonly fixturesDir: string;
  private readonly timeScale: number;
  private readonly onEvent: (event: FetcherEvent) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ReplayFetcherOptions = {}) {
    this.fixturesDir = options.fixturesDir ?? resolve("fixtures/recorded");
    this.timeScale = options.timeScale ?? 0.01;
    if (!Number.isFinite(this.timeScale) || this.timeScale < 0) {
      throw new Error("Replay timeScale must be a non-negative number");
    }
    this.onEvent = options.onEvent ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
  }

  async runAudit<T>(
    target: Target,
    operation: (session: AuditSession) => Promise<T>,
  ): Promise<T> {
    return await queued(async () => {
      assertTargetEligible(target);
      const recording = this.options.recording ?? (await this.loadLatest(target.alias));
      if (recording.alias !== target.alias || recording.mode !== target.mode) {
        throw new FetcherError("REPLAY_MISMATCH", "Recording target or mode does not match");
      }
      let index = 0;
      const backend: SessionBackend = {
        next: async (url, method) => {
          const exchange = recording.exchanges[index];
          index += 1;
          if (exchange === undefined || exchange.url !== url.toString() || exchange.method !== method) {
            throw new FetcherError(
              "REPLAY_MISMATCH",
              `Recording does not contain ${method} ${url.toString()} at exchange ${index}`,
            );
          }
          const body = Buffer.from(exchange.body, exchange.bodyEncoding);
          if (body.byteLength > MAX_RESPONSE_BYTES) {
            throw new FetcherError(
              "RESPONSE_TOO_LARGE",
              `Recorded response exceeded ${MAX_RESPONSE_BYTES} bytes`,
            );
          }
          return {
            url: exchange.url,
            method: exchange.method,
            status: exchange.status,
            headers: { ...exchange.headers },
            body,
            timestamp: exchange.timestamp,
            ms: exchange.ms,
          };
        },
      };
      return await operation(
        new GuardedSession({
          target,
          backend,
          onEvent: this.onEvent,
          now: this.now,
          sleep: this.sleep,
          timeScale: this.timeScale,
        }),
      );
    });
  }

  private async loadLatest(alias: string): Promise<AuditRecording> {
    const names = (await readdir(this.fixturesDir))
      .filter((name) => name.startsWith(`${alias}-`) && name.endsWith(".json"))
      .sort()
      .reverse();
    const latest = names[0];
    if (latest === undefined) throw new Error(`No recording found for ${alias}`);
    const value = JSON.parse(await readFile(resolve(this.fixturesDir, latest), "utf8")) as unknown;
    return parseRecording(value);
  }
}

export function assertTargetEligible(target: Target): void {
  if (!target.tosReviewed) {
    throw new FetcherError("TARGET_NOT_REVIEWED", `${target.alias} has not completed terms review`);
  }
  if (target.tos.status === "prohibited") {
    throw new FetcherError("TERMS_PROHIBITED", `${target.alias} prohibits automated access`);
  }
}

export function assertTargetAllowlisted(target: Target, allowlist: readonly Target[]): void {
  const matches = allowlist.some((configured) =>
    configured.alias === target.alias &&
    configured.host === target.host &&
    configured.mode === target.mode &&
    configured.catalogUrl === target.catalogUrl &&
    configured.dialect === target.dialect &&
    configured.tosReviewed === target.tosReviewed &&
    configured.tos.status === target.tos.status &&
    configured.tos.sourceUrl === target.tos.sourceUrl &&
    configured.tos.evidence === target.tos.evidence &&
    configured.tos.reviewedOn === target.tos.reviewedOn
  );
  if (!matches) {
    throw new FetcherError(
      "TARGET_NOT_ALLOWLISTED",
      `${target.alias} does not exactly match config/targets.json`,
    );
  }
}

export function parseRecording(value: unknown): AuditRecording {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recording must be an object");
  }
  const input = value as Partial<AuditRecording>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.alias !== "string" ||
    (input.mode !== "knock" && input.mode !== "audit" && input.mode !== "catalog-census" && input.mode !== "catalog-census-v4") ||
    typeof input.recordedAt !== "string" ||
    !Array.isArray(input.exchanges)
  ) {
    throw new Error("Recording metadata is invalid");
  }
  for (const exchange of input.exchanges) {
    if (
      typeof exchange !== "object" ||
      exchange === null ||
      (exchange.method !== "GET" && exchange.method !== "HEAD") ||
      typeof exchange.url !== "string" ||
      typeof exchange.status !== "number" ||
      typeof exchange.body !== "string" ||
      exchange.bodyEncoding !== "base64"
    ) {
      throw new Error("Recording exchange is invalid");
    }
  }
  return input as AuditRecording;
}
