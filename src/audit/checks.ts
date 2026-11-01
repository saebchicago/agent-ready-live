import type { Target, TargetDialect } from "../config.js";
import {
  FetcherError,
  type Fetcher,
  type FetchResponse,
  type RobotsPolicy,
} from "./fetcher.js";

export type CheckLabel = "Verified" | "Modeled";

export interface CheckResult {
  id: "T0" | "K1" | "K2" | "K3" | "K4" | "D1" | "D2" | "D3" | "D4" | "D5";
  outcome: string;
  evidence: string;
  label: CheckLabel;
}

export interface AuditCheckResult {
  checks: CheckResult[];
  sampledEntries: number;
  probedOn: string;
}

export interface AuditCheckHooks {
  beforeCheck?: (id: CheckResult["id"]) => void | Promise<void>;
  onCheck?: (check: CheckResult) => void | Promise<void>;
}

interface CatalogEntry {
  license: unknown;
  description: unknown;
  dates: unknown[];
  distributionUrls: string[];
}

const SPDX_IDS = new Set([
  "0bsd",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "cc-by-4.0",
  "cc0-1.0",
  "gpl-2.0-only",
  "gpl-3.0-only",
  "mit",
  "mpl-2.0",
  "odc-by-1.0",
  "odbl-1.0",
  "pddl-1.0",
]);

function result(id: CheckResult["id"], outcome: string, evidence: string): CheckResult {
  return { id, outcome, evidence, label: "Verified" };
}

function textBody(response: FetchResponse): string {
  return Buffer.from(response.body).toString("utf8");
}

function isSuccessful(response: FetchResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

function missingChecks(ids: CheckResult["id"][], reason: string): CheckResult[] {
  return ids.map((id) => result(id, "not_found_in_sample", `Not found in sample: ${reason}`));
}

export function checkT0(target: Target): CheckResult {
  if (!target.tosReviewed) {
    return result(
      "T0",
      "TERMS_NOT_REVIEWED",
      `Terms review is incomplete. No network request is permitted. Source: ${target.tos.sourceUrl}`,
    );
  }
  if (target.tos.status === "prohibited") {
    return result(
      "T0",
      "DOOR_CLOSED_BY_TERMS",
      `${target.tos.evidence} Source: ${target.tos.sourceUrl}`,
    );
  }
  return result(
    "T0",
    "TERMS_GATE_OPEN",
    `${target.tos.evidence} Source: ${target.tos.sourceUrl}`,
  );
}

export function checkK1(policy: RobotsPolicy): CheckResult {
  const evidence: Record<RobotsPolicy["kind"], string> = {
    present: `robots.txt returned ${policy.status ?? 200}.`,
    not_found: `robots.txt returned ${policy.status ?? "4xx"}; RFC 9309 treats it as no rules.`,
    server_error: `robots.txt returned ${policy.status ?? "5xx"}; treated as full disallow.`,
    unreachable: "robots.txt was unreachable; treated as full disallow.",
    BLOCKED_BY_WAF: "robots.txt returned a firewall or WAF block page; the audit stopped.",
  };
  return result("K1", policy.kind, evidence[policy.kind]);
}

export function checkK2(policy: RobotsPolicy, plannedUrls: readonly string[]): CheckResult {
  if (policy.kind === "server_error" || policy.kind === "unreachable" || policy.kind === "BLOCKED_BY_WAF") {
    return result("K2", "disallowed", `Access was not allowed because K1 was ${policy.kind}. Respected.`);
  }
  const allowed = plannedUrls.filter((url) => policy.isAllowed(url));
  const blockedUrl = plannedUrls.find((url) => !policy.isAllowed(url));
  const matchingLine = blockedUrl === undefined ? -1 : policy.matchingLine(blockedUrl);
  const matchingRule = matchingLine > 0 ? policy.text.split(/\r?\n/u)[matchingLine - 1]?.trim() : undefined;
  const blockedEvidence = blockedUrl !== undefined && matchingRule !== undefined
    ? ` Blocked by robots.txt: ${matchingRule} (path ${new URL(blockedUrl).pathname}).`
    : "";
  if (allowed.length === 0) {
    return result("K2", "disallowed", `robots.txt disallows every planned path for AgentReadyLive. Respected.${blockedEvidence}`);
  }
  if (allowed.length < plannedUrls.length || policy.crawlDelayMs > 0) {
    return result(
      "K2",
      "allowed_with_limits",
      `${allowed.length} of ${plannedUrls.length} planned paths allowed; declared limits are respected.${blockedEvidence}`,
    );
  }
  return result("K2", "allowed", `All ${plannedUrls.length} planned paths are allowed.`);
}

export function checkK3(robotsText: string, llmsResponse?: FetchResponse): CheckResult {
  const hasContentSignal = /^\s*content-signal\s*:/imu.test(robotsText);
  const hasAiAgentRules = /^\s*user-agent\s*:\s*(?:gptbot|chatgpt-user|claudebot|google-extended|ccbot|perplexitybot|agentreadylive)/imu.test(
    robotsText,
  );
  const llmsPresent = llmsResponse !== undefined && isSuccessful(llmsResponse) && textBody(llmsResponse).trim() !== "";
  if (hasContentSignal || llmsPresent) {
    const sources = [hasContentSignal ? "Content-Signal" : "", llmsPresent ? "llms.txt" : ""]
      .filter(Boolean)
      .join(" and ");
    return result("K3", "stated", `AI-use policy stated through ${sources}.`);
  }
  if (hasAiAgentRules) {
    return result("K3", "partial", "AI-specific user-agent rules are present without a broader AI-use statement.");
  }
  return result("K3", "silent", "No AI-use policy was found in the sampled bot-facing files; silence is informational.");
}

export function checkK4(policy: RobotsPolicy): CheckResult {
  if (policy.crawlDelayMs <= 0) return result("K4", "none", "No Crawl-delay was declared.");
  return result(
    "K4",
    "declared_and_honored",
    `Crawl-delay ${policy.crawlDelayMs / 1_000} seconds was declared and honored.`,
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = object(value);
  if (record === undefined) return undefined;
  for (const key of ["@id", "id", "url", "title", "name"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function distributionUrls(value: unknown): string[] {
  const urls: string[] = [];
  for (const item of array(value)) {
    if (typeof item === "string") {
      urls.push(item);
      continue;
    }
    const record = object(item);
    if (record === undefined) continue;
    for (const key of ["downloadURL", "accessURL", "url", "endpointURL"]) {
      const url = stringValue(record[key]);
      if (url !== undefined) urls.push(url);
    }
  }
  return urls;
}

function parseDcat(root: Record<string, unknown>): CatalogEntry[] {
  const datasets = array(root.dataset ?? root["@graph"]);
  return datasets.flatMap((item) => {
    const entry = object(item);
    if (entry === undefined) return [];
    return [{
      license: entry.license,
      description: entry.description,
      dates: [entry.modified, entry.issued].filter((value) => value !== undefined),
      distributionUrls: distributionUrls(entry.distribution),
    }];
  });
}

function parseCkan(root: Record<string, unknown>): CatalogEntry[] {
  const resultValue = object(root.result);
  return array(resultValue?.results).flatMap((item) => {
    const entry = object(item);
    if (entry === undefined) return [];
    return [{
      license: entry.license_url ?? entry.license_id ?? entry.license_title,
      description: entry.notes,
      dates: [entry.metadata_modified, entry.metadata_created].filter((value) => value !== undefined),
      distributionUrls: distributionUrls(entry.resources),
    }];
  });
}

function parseSocrata(root: Record<string, unknown>): CatalogEntry[] {
  return array(root.results).flatMap((item) => {
    const entry = object(item);
    const resource = object(entry?.resource);
    const metadata = object(entry?.metadata);
    if (entry === undefined) return [];
    return [{
      license: metadata?.license ?? entry.license,
      description: resource?.description ?? entry.description,
      dates: [resource?.updatedAt, resource?.createdAt].filter((value) => value !== undefined),
      distributionUrls: distributionUrls(entry.distribution ?? entry.permalink),
    }];
  });
}

export function parseCatalog(text: string, dialect: TargetDialect): CatalogEntry[] {
  const parsed = object(JSON.parse(text) as unknown);
  if (parsed === undefined) throw new Error("Catalog root must be an object");
  if (dialect === "dcat") return parseDcat(parsed);
  if (dialect === "ckan") return parseCkan(parsed);
  return parseSocrata(parsed);
}

export function checkD1(response: FetchResponse | undefined, entries: readonly CatalogEntry[]): CheckResult {
  if (response === undefined || !isSuccessful(response) || entries.length === 0) {
    return result("D1", "not_found_in_sample", "Machine-readable catalog not found in sample.");
  }
  return result("D1", "reachable", `Machine-readable catalog reached; sampled ${entries.length} entries.`);
}

function licenseClass(value: unknown): "machine" | "prose" | "empty" {
  const text = stringValue(value)?.trim() ?? "";
  if (text === "" || /^tbd$/iu.test(text)) return "empty";
  if (/^https?:\/\//iu.test(text) || SPDX_IDS.has(text.toLowerCase())) return "machine";
  return "prose";
}

export function checkD2(entries: readonly CatalogEntry[]): CheckResult {
  if (entries.length === 0) return result("D2", "not_found_in_sample", "License not found in sample (N=0)." );
  const counts = { machine: 0, prose: 0, empty: 0 };
  for (const entry of entries) counts[licenseClass(entry.license)] += 1;
  const outcome = counts.empty > 0
    ? "empty_or_tbd"
    : counts.prose > 0
      ? "prose"
      : "url_or_spdx";
  return result(
    "D2",
    outcome,
    `Sampled N=${entries.length}: URL or SPDX ${counts.machine}, prose ${counts.prose}, empty or TBD ${counts.empty}.`,
  );
}

function descriptionClass(value: unknown): "present" | "short" | "empty" {
  const text = stringValue(value)?.trim() ?? "";
  if (text === "" || /\{\{\s*description\s*\}\}/iu.test(text)) return "empty";
  return text.length < 40 ? "short" : "present";
}

export function checkD3(entries: readonly CatalogEntry[]): CheckResult {
  if (entries.length === 0) return result("D3", "not_found_in_sample", "Descriptions not found in sample (N=0)." );
  const counts = { present: 0, short: 0, empty: 0 };
  for (const entry of entries) counts[descriptionClass(entry.description)] += 1;
  const outcome = counts.empty > 0
    ? "empty_or_template"
    : counts.short > 0
      ? "short"
      : "present";
  return result(
    "D3",
    outcome,
    `Sampled N=${entries.length}: present ${counts.present}, short ${counts.short}, empty or template ${counts.empty}.`,
  );
}

function dateClass(
  values: readonly unknown[],
  probeDate: Date,
): "sane" | "stale" | "impossible" | "missing" {
  const raw = values.map(stringValue).find((value) => value !== undefined && value.trim() !== "");
  if (raw === undefined) return "missing";
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return "impossible";
  const date = new Date(timestamp);
  if (date.getUTCFullYear() < 1990 || timestamp > probeDate.getTime()) return "impossible";
  const staleBefore = Date.UTC(
    probeDate.getUTCFullYear() - 5,
    probeDate.getUTCMonth(),
    probeDate.getUTCDate(),
  );
  return timestamp < staleBefore ? "stale" : "sane";
}

export function checkD4(entries: readonly CatalogEntry[], probeDate: Date): CheckResult {
  if (entries.length === 0) return result("D4", "not_found_in_sample", "Dates not found in sample (N=0)." );
  const counts = { sane: 0, stale: 0, impossible: 0, missing: 0 };
  for (const entry of entries) counts[dateClass(entry.dates, probeDate)] += 1;
  const outcome = counts.impossible > 0
    ? "impossible"
    : counts.stale > 0
      ? "stale"
      : counts.sane > 0
        ? "sane"
        : "not_found_in_sample";
  return result(
    "D4",
    outcome,
    `Sampled N=${entries.length}: sane ${counts.sane}, stale ${counts.stale}, impossible ${counts.impossible}, not found ${counts.missing}.`,
  );
}

export function checkD5(response: FetchResponse | undefined): CheckResult {
  if (response === undefined || !isSuccessful(response)) {
    return result("D5", "not_found_in_sample", "Sanctioned data lane not found in sample.");
  }
  const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    return result("D5", "landing_page_only", `Sampled distribution responded ${response.status} with ${contentType}.`);
  }
  return result("D5", "api_or_bulk_endpoint", `Sampled distribution responded ${response.status} with ${contentType || "a non-HTML response"}.`);
}

function plannedUrls(target: Target): string[] {
  if (target.mode === "knock") return [`https://${target.host}/llms.txt`];
  return target.catalogUrl === undefined ? [] : [target.catalogUrl];
}

function firstDistribution(entries: readonly CatalogEntry[], target: Target): string | undefined {
  for (const entry of entries) {
    for (const raw of entry.distributionUrls) {
      try {
        const url = new URL(raw);
        if (url.hostname.toLowerCase() === target.host) return url.toString();
      } catch {
        // Invalid distribution URLs are evidence of no usable lane in the sample.
      }
    }
  }
  return undefined;
}

export async function runAuditChecks(
  target: Target,
  fetcher: Fetcher,
  now: () => Date = () => new Date(),
  hooks: AuditCheckHooks = {},
): Promise<AuditCheckResult> {
  const checks: CheckResult[] = [];
  const reveal = async (check: CheckResult): Promise<void> => {
    await hooks.beforeCheck?.(check.id);
    checks.push(check);
    await hooks.onCheck?.(check);
  };
  const t0 = checkT0(target);
  const probedOn = now().toISOString().slice(0, 10);
  await reveal(t0);
  if (t0.outcome !== "TERMS_GATE_OPEN") {
    return { checks, sampledEntries: 0, probedOn };
  }

  return await fetcher.runAudit(target, async (session) => {
    const policy = await session.robots();
    await reveal(checkK1(policy));
    if (policy.kind === "BLOCKED_BY_WAF") return { checks, sampledEntries: 0, probedOn };

    const paths = plannedUrls(target);
    await reveal(checkK2(policy, paths));
    if (policy.stopped) {
      await reveal(checkK3(policy.text));
      await reveal(checkK4(policy));
      return { checks, sampledEntries: 0, probedOn };
    }

    if (target.mode === "knock") {
      await hooks.beforeCheck?.("K3");
      let llms: FetchResponse | undefined;
      try {
        llms = await session.request(paths[0] ?? `https://${target.host}/llms.txt`, "GET");
      } catch (error) {
        if (!(error instanceof FetcherError)) throw error;
      }
      const k3 = checkK3(policy.text, llms);
      checks.push(k3);
      await hooks.onCheck?.(k3);
      await reveal(checkK4(policy));
      return { checks, sampledEntries: 0, probedOn };
    }

    await reveal(checkK3(policy.text));
    await reveal(checkK4(policy));
    if (target.catalogUrl === undefined || target.dialect === undefined) {
      for (const check of missingChecks(
        ["D1", "D2", "D3", "D4", "D5"],
        "target has no configured catalog endpoint",
      )) {
        await reveal(check);
      }
      return { checks, sampledEntries: 0, probedOn };
    }

    let catalogResponse: FetchResponse | undefined;
    let entries: CatalogEntry[] = [];
    let catalogReason = "catalog request did not return a usable sample";
    try {
      catalogResponse = await session.request(target.catalogUrl, "GET");
      if (isSuccessful(catalogResponse)) {
        entries = parseCatalog(textBody(catalogResponse), target.dialect).slice(0, 50);
      }
    } catch (error) {
      if (!(error instanceof FetcherError || error instanceof SyntaxError)) throw error;
      catalogReason = error instanceof FetcherError ? error.message : "catalog response was not valid JSON";
    }

    await reveal(checkD1(catalogResponse, entries));
    await reveal(checkD2(entries));
    await reveal(checkD3(entries));
    await reveal(checkD4(entries, now()));

    const distribution = firstDistribution(entries, target);
    if (distribution === undefined) {
      await reveal(result(
        "D5",
        "not_found_in_sample",
        `Sanctioned data lane not found in sample: ${catalogReason}.`,
      ));
    } else {
      let head: FetchResponse | undefined;
      try {
        head = await session.request(distribution, "HEAD");
      } catch (error) {
        if (!(error instanceof FetcherError)) throw error;
      }
      await reveal(checkD5(head));
    }
    return { checks, sampledEntries: entries.length, probedOn };
  });
}
