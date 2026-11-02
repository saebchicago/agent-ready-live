import type { AuditRecording, RecordedExchange } from "./fetcher.js";
import type { Target } from "../config.js";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { legacyCkanRoundLine, LEGACY_CKAN_EXPLAINER } from "./census-v4.js";

export interface FacetCount {
  name: string;
  count: number;
  share: number | undefined;
}

export interface NationalCensus {
  probedOn: string;
  totalDatasets: number | undefined;
  licenseFacetAvailable: boolean;
  licenses: FacetCount[];
  noLicenseCount: number | undefined;
  noLicenseShare: number | undefined;
  formatsAvailable: boolean;
  formats: FacetCount[];
  publishersAvailable: boolean;
  publishers: FacetCount[];
  namedPublisherCounts: Record<string, number | undefined>;
  truncated: boolean;
  notes: string[];
  legacyRoundLine?: string;
  legacyExplainer?: typeof LEGACY_CKAN_EXPLAINER;
}

export const CENSUS_PUBLISHER_TERMS = ["Michigan", "Detroit", "Chicago", "New York", "Boston"] as const;

export function censusRequestUrls(target: Target): [string, string] {
  const endpoint = new URL(`https://${target.host}/api/3/action/package_search`);
  const callA = new URL(endpoint);
  callA.searchParams.set("rows", "1");
  callA.searchParams.set("facet.field", JSON.stringify(["license_id", "organization", "res_format"]));
  callA.searchParams.set("facet.limit", "25");
  const callB = new URL(endpoint);
  callB.searchParams.set("rows", "0");
  callB.searchParams.set("facet.field", JSON.stringify(["organization"]));
  callB.searchParams.set("facet.limit", "-1");
  return [callA.toString(), callB.toString()];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function facet(value: unknown): Array<{ name: string; count: number }> | undefined {
  const input = object(value);
  if (!input) return undefined;
  const values: Array<{ name: string; count: number }> = [];
  for (const [name, rawCount] of Object.entries(input)) {
    const parsed = count(rawCount);
    if (parsed === undefined) return undefined;
    values.push({ name, count: parsed });
  }
  return values.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function body(exchange: RecordedExchange | undefined): Record<string, unknown> | undefined {
  if (!exchange || exchange.status < 200 || exchange.status >= 300 || exchange.truncated) return undefined;
  try {
    return object(JSON.parse(Buffer.from(exchange.body, exchange.bodyEncoding).toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function result(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return object(value?.result);
}

function proportion(value: number | undefined, total: number | undefined): number | undefined {
  return value === undefined || total === undefined || total <= 0 ? undefined : value / total;
}

export function deriveNationalCensus(
  callA: RecordedExchange | undefined,
  callB: RecordedExchange | undefined,
  probedOn: string,
  truncated = false,
  censusError?: string,
): NationalCensus {
  const a = body(callA);
  const b = body(callB);
  const aResult = result(a);
  const bResult = result(b);
  const total = count(aResult?.count);
  const facetsA = object(aResult?.facets);
  const facetsB = object(bResult?.facets);

  const licenseFacet = facet(facetsA?.license_id);
  const formatFacet = facet(facetsA?.res_format);
  const publisherFacet = facet(facetsB?.organization);
  const licenseSum = licenseFacet?.reduce((sum, item) => sum + item.count, 0);
  const noLicenseCount = total === undefined || licenseSum === undefined ? undefined : total - licenseSum;
  const namedPublisherCounts: Record<string, number | undefined> = {};
  for (const term of CENSUS_PUBLISHER_TERMS) {
    if (publisherFacet === undefined) namedPublisherCounts[term] = undefined;
    else namedPublisherCounts[term] = publisherFacet
      .filter(({ name }) => name.toLowerCase().includes(term.toLowerCase()))
      .reduce((sum, item) => sum + item.count, 0);
  }

  const notes: string[] = [];
  if (!a || !aResult) notes.push("Call A summary not available in this catalog.");
  if (!licenseFacet) notes.push("License facet not available in this catalog.");
  if (!formatFacet) notes.push("Format facet not available in this catalog.");
  if (!publisherFacet) notes.push("Publisher facet not available in this catalog.");
  if (callA?.truncated) notes.push("Call A was truncated at the 5 MB response cap.");
  if (callB?.truncated) notes.push("Call B was truncated at the 5 MB response cap.");
  if (truncated && !callA?.truncated && !callB?.truncated) notes.push("A census response was truncated at the 5 MB response cap.");
  if (censusError) notes.push(`Census stopped safely: ${censusError}`);
  if (callA && (callA.status < 200 || callA.status >= 300)) notes.push(`Call A returned HTTP ${callA.status}; no retry was made.`);
  if (callB && (callB.status < 200 || callB.status >= 300)) notes.push(`Call B returned HTTP ${callB.status}; no retry was made.`);

  const legacyRoundLine = legacyCkanRoundLine(callA?.status, probedOn);
  return {
    probedOn,
    totalDatasets: total,
    licenseFacetAvailable: licenseFacet !== undefined,
    licenses: licenseFacet?.map((item) => ({ ...item, share: proportion(item.count, total) })) ?? [],
    noLicenseCount,
    noLicenseShare: proportion(noLicenseCount, total),
    formatsAvailable: formatFacet !== undefined,
    formats: formatFacet?.map((item) => ({ ...item, share: proportion(item.count, total) })) ?? [],
    publishersAvailable: publisherFacet !== undefined,
    publishers: publisherFacet?.map((item) => ({ ...item, share: proportion(item.count, total) })) ?? [],
    namedPublisherCounts,
    truncated,
    notes,
    ...(legacyRoundLine === undefined ? {} : { legacyRoundLine, legacyExplainer: LEGACY_CKAN_EXPLAINER }),
  };
}

export function exchangesForCensus(recording: AuditRecording): { callA: RecordedExchange | undefined; callB: RecordedExchange | undefined } {
  const calls = recording.exchanges.filter(({ url }) => new URL(url).pathname === "/api/3/action/package_search");
  return { callA: calls[0], callB: calls[1] };
}

export function nationalCensusFromRecording(recording: AuditRecording): NationalCensus {
  const { callA, callB } = exchangesForCensus(recording);
  return deriveNationalCensus(
    callA,
    callB,
    recording.recordedAt.slice(0, 10),
    callA?.truncated === true || callB?.truncated === true,
    recording.censusError,
  );
}

export async function loadLatestNationalCensus(
  fixtureDirectory = resolve("fixtures/recorded"),
): Promise<NationalCensus | undefined> {
  let files: string[];
  try {
    files = (await readdir(fixtureDirectory)).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  let latest: AuditRecording | undefined;
  for (const file of files) {
    try {
      const recording = JSON.parse(await readFile(resolve(fixtureDirectory, file), "utf8")) as AuditRecording;
      if (recording.alias === "datagov" && recording.mode === "catalog-census" &&
        (latest === undefined || recording.recordedAt > latest.recordedAt)) latest = recording;
    } catch {
      // Ignore unrelated malformed fixture files. The report remains unavailable until a valid one exists.
    }
  }
  return latest === undefined ? undefined : nationalCensusFromRecording(latest);
}

export function formatCensusForChat(census: NationalCensus | undefined): string {
  if (!census) return "National lens not available in this catalog. Probed not available | Not a ranking";
  const total = census.totalDatasets === undefined ? "Total not available in this catalog" : `${census.totalDatasets} datasets`;
  const licenses = census.licenseFacetAvailable
    ? census.licenses.slice(0, 3).map(({ name, count, share }) => `${name} ${count} (${share === undefined ? "share not available in this catalog" : `${(share * 100).toFixed(2)}%`})`).join(", ") || "none reported"
    : "not available in this catalog";
  const missing = census.noLicenseCount === undefined
    ? "No-license share not available in this catalog"
    : `${census.noLicenseCount} without a license (${census.noLicenseShare === undefined ? "share not available in this catalog" : `${(census.noLicenseShare * 100).toFixed(2)}%`})`;
  const topFormat = census.formats[0] ? `Top format ${census.formats[0].name} (${census.formats[0].count})` : "Formats not available in this catalog";
  const topPublisher = census.publishers[0] ? `Top publisher ${census.publishers[0].name} (${census.publishers[0].count})` : "Publishers not available in this catalog";
  const truncation = census.truncated ? ` ${census.notes.filter((note) => note.includes("truncated at")).join(" ")}` : "";
  return `National lens: ${total}; licenses ${licenses}; ${missing}; ${topFormat}; ${topPublisher}.${truncation} Probed ${census.probedOn} | Not a ranking`;
}

export function formatPublisherForChat(census: NationalCensus | undefined, name: string): string {
  if (!census?.publishersAvailable) return `Publisher data not available in this catalog. Probed ${census?.probedOn ?? "not available"} | Not a ranking`;
  const matches = census.publishers.filter((publisher) => publisher.name.toLowerCase().includes(name.toLowerCase()));
  if (matches.length === 0) return `No ${name} publisher found in this catalog. Probed ${census.probedOn} | Not a ranking`;
  const response = matches.slice(0, 3).map(({ name: publisher, count: total }) => `${publisher}: ${total}`).join("; ");
  return `${response}. Probed ${census.probedOn} | Not a ranking`;
}
