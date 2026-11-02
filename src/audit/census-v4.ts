import type { AuditRecording, FetchResponse, RecordedExchange } from "./fetcher.js";
import type { Target } from "../config.js";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export const DATAGOV_V4_BASE_PATH = "/technology/datagov/v4/";
export const DATAGOV_V4_PUBLISHER_TERMS = ["Michigan", "Detroit", "Chicago", "New York City", "Boston"] as const;
export const DATAGOV_ORGANIZATION_TYPES = ["Federal", "State", "City", "County"] as const;

export type DataGovOrganizationType = (typeof DATAGOV_ORGANIZATION_TYPES)[number];

export interface DataGovV4Publisher {
  queryTerm: string;
  name: string;
  slug: string;
  organizationType: string | undefined;
  datasetCount: number | undefined;
  sampleCount: number | undefined;
  licensedCount: number | undefined;
  licenseShare: number | undefined;
}

export interface DataGovV4Census {
  probedOn: string;
  publishers: number | undefined;
  datasets: number | undefined;
  byType: Record<DataGovOrganizationType, number | undefined>;
  publishersBySearch: DataGovV4Publisher[];
  notInDataGov: string[];
  notes: string[];
}

export function dataGovV4OrganizationsUrl(target: Target): string {
  return `https://${target.host}${DATAGOV_V4_BASE_PATH}api/organizations`;
}

export function dataGovV4SearchUrl(target: Target, slug: string): string {
  const url = new URL(`https://${target.host}${DATAGOV_V4_BASE_PATH}search`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("org_slug", slug);
  return url.toString();
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = object(value);
  if (!record) return undefined;
  for (const key of ["organizations", "results", "data", "items"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function body(exchange: RecordedExchange | undefined): Record<string, unknown> | undefined {
  if (!exchange || exchange.truncated || exchange.status < 200 || exchange.status >= 300) return undefined;
  try {
    const parsed = object(JSON.parse(Buffer.from(exchange.body, exchange.bodyEncoding).toString("utf8")) as unknown);
    if (!parsed) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

interface Organization {
  name: string;
  slug: string;
  organizationType: string | undefined;
  datasetCount: number | undefined;
}

function organizationRows(value: Record<string, unknown> | undefined): unknown[] | undefined {
  if (!value) return undefined;
  return array(value.organizations ?? value.results ?? value.data ?? value.items);
}

function organizationsFrom(value: Record<string, unknown> | undefined): Organization[] | undefined {
  const rows = organizationRows(value);
  if (!rows) return undefined;
  const organizations: Organization[] = [];
  for (const item of rows) {
    const row = object(item);
    if (!row) return undefined;
    const name = typeof row.name === "string" ? row.name : typeof row.title === "string" ? row.title : undefined;
    const slug = typeof row.slug === "string" ? row.slug : typeof row.org_slug === "string" ? row.org_slug : undefined;
    if (name === undefined || slug === undefined) return undefined;
    const type = row.organization_type ?? row.organizationType ?? row.type;
    const count = row.dataset_count ?? row.datasetCount ?? row.datasets_count ?? row.datasetsCount;
    organizations.push({
      name,
      slug,
      organizationType: typeof type === "string" ? type : undefined,
      datasetCount: numeric(count),
    });
  }
  return organizations;
}

export function publisherRequestsFromResponse(response: FetchResponse): {
  publishers: Array<Pick<DataGovV4Publisher, "queryTerm" | "name" | "slug">>;
  notInDataGov: string[];
} {
  if (response.status < 200 || response.status >= 300) return { publishers: [], notInDataGov: [] };
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = object(JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown);
    parsed = object(raw?.data) ?? raw;
  } catch {
    return { publishers: [], notInDataGov: [] };
  }
  const organizations = organizationsFrom(parsed);
  if (!organizations) return { publishers: [], notInDataGov: [] };
  const publishers: Array<Pick<DataGovV4Publisher, "queryTerm" | "name" | "slug">> = [];
  const notInDataGov: string[] = [];
  for (const queryTerm of DATAGOV_V4_PUBLISHER_TERMS) {
    const organization = organizations.find(({ name }) => name.toLowerCase().includes(queryTerm.toLowerCase()));
    if (!organization) {
      notInDataGov.push(queryTerm);
    } else if (!publishers.some(({ slug }) => slug === organization.slug)) {
      publishers.push({ queryTerm, name: organization.name, slug: organization.slug });
    }
  }
  return { publishers, notInDataGov };
}

function totalPublishers(response: Record<string, unknown> | undefined, organizations: Organization[] | undefined, rowCount: number | undefined): number | undefined {
  if (!response) return undefined;
  const data = object(response.data);
  const meta = object(response.meta) ?? object(response.pagination) ?? object(data?.meta) ?? object(data?.pagination);
  const explicit = numeric(response.total_publishers ?? response.totalOrganizations ?? response.total_organizations ?? data?.total_publishers ?? data?.totalOrganizations ?? data?.total_organizations ?? meta?.total);
  return explicit ?? organizations?.length ?? rowCount;
}

function typeBucket(value: string | undefined): DataGovOrganizationType | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return DATAGOV_ORGANIZATION_TYPES.find((type) => normalized.includes(type.toLowerCase()));
}

function exchangeText(exchange: RecordedExchange | undefined): Record<string, unknown> | undefined {
  return body(exchange);
}

function searchRecords(response: RecordedExchange | undefined): unknown[] | undefined {
  const payload = exchangeText(response);
  if (!payload) return undefined;
  return array(payload.results ?? payload.datasets ?? payload.items ?? payload.data);
}

function hasLicense(record: unknown): boolean {
  const row = object(record);
  const dcat = object(row?.dcat);
  const license = dcat?.license;
  if (typeof license === "string") return license.trim().length > 0;
  return license !== undefined && license !== null;
}

function exchanges(recording: AuditRecording): {
  organizations: RecordedExchange | undefined;
  searches: Map<string, RecordedExchange>;
} {
  let organizations: RecordedExchange | undefined;
  const searches = new Map<string, RecordedExchange>();
  for (const exchange of recording.exchanges) {
    const url = new URL(exchange.url);
    if (url.pathname === `${DATAGOV_V4_BASE_PATH}api/organizations`) {
      organizations ??= exchange;
    } else if (url.pathname === `${DATAGOV_V4_BASE_PATH}search`) {
      const slug = url.searchParams.get("org_slug");
      if (slug !== null && !searches.has(slug)) searches.set(slug, exchange);
    }
  }
  return { organizations, searches };
}

export function deriveDataGovV4Census(
  organizationsExchange: RecordedExchange | undefined,
  searchExchanges: ReadonlyMap<string, RecordedExchange>,
  probedOn: string,
): DataGovV4Census {
  const response = body(organizationsExchange);
  const orgRows = organizationRows(response);
  const organizations = organizationsFrom(response);
  const publishers = totalPublishers(response, organizations, orgRows?.length);
  let datasets: number | undefined;
  const byType = Object.fromEntries(DATAGOV_ORGANIZATION_TYPES.map((type) => [type, 0])) as Record<DataGovOrganizationType, number | undefined>;
  const organizationListComplete = organizations !== undefined && (publishers === undefined || organizations.length >= publishers);
  const allDatasetCountsPresent = organizations !== undefined && organizationListComplete && organizations.every(({ datasetCount }) => datasetCount !== undefined);
  const allTypesPresent = organizations !== undefined && organizationListComplete && organizations.every(({ organizationType }) => organizationType !== undefined);
  if (allDatasetCountsPresent && organizations !== undefined) {
    datasets = organizations.reduce((sum, organization) => sum + organization.datasetCount!, 0);
    if (allTypesPresent) {
      for (const organization of organizations) {
        const bucket = typeBucket(organization.organizationType);
        if (bucket !== undefined) byType[bucket] = byType[bucket]! + organization.datasetCount!;
      }
    } else {
      for (const type of DATAGOV_ORGANIZATION_TYPES) byType[type] = undefined;
    }
  } else {
    datasets = undefined;
    for (const type of DATAGOV_ORGANIZATION_TYPES) byType[type] = undefined;
  }

  const selected: DataGovV4Publisher[] = [];
  const notInDataGov: string[] = [];
  for (const queryTerm of DATAGOV_V4_PUBLISHER_TERMS) {
    const organization = organizations?.find(({ name }) => name.toLowerCase().includes(queryTerm.toLowerCase()));
    if (!organization) {
      if (organizations !== undefined) notInDataGov.push(queryTerm);
      continue;
    }
    const search = searchExchanges.get(organization.slug);
    const records = searchRecords(search);
    const licensedCount = records?.filter(hasLicense).length;
    selected.push({
      queryTerm,
      name: organization.name,
      slug: organization.slug,
      organizationType: organization.organizationType,
      datasetCount: organization.datasetCount,
      sampleCount: records?.length,
      licensedCount,
      licenseShare: records === undefined || records.length === 0 || licensedCount === undefined
        ? undefined
        : licensedCount / records.length,
    });
  }

  const notes: string[] = [];
  if (!organizationsExchange) notes.push("Organization response not available.");
  else if (!response || !organizations) notes.push("Organization response fields not available in this API response.");
  else if (!organizationListComplete) notes.push("Organization list is incomplete in this API response; dataset totals are not available.");
  if (organizationsExchange?.truncated) notes.push("Organization response was truncated at the 5 MB response cap.");
  if (organizationsExchange && (organizationsExchange.status < 200 || organizationsExchange.status >= 300)) {
    notes.push(`Organization endpoint returned HTTP ${organizationsExchange.status}; no retry was made.`);
  }
  for (const publisher of selected) {
    const search = searchExchanges.get(publisher.slug);
    if (search?.truncated) notes.push(`${publisher.name} search response was truncated at the 5 MB response cap.`);
    else if (search && (search.status < 200 || search.status >= 300)) notes.push(`${publisher.name} search returned HTTP ${search.status}; no retry was made.`);
    else if (publisher.sampleCount === undefined) notes.push(`${publisher.name} sample not available in this API response.`);
  }
  return { probedOn, publishers, datasets, byType, publishersBySearch: selected, notInDataGov, notes };
}

export function dataGovV4CensusFromRecording(recording: AuditRecording): DataGovV4Census {
  const found = exchanges(recording);
  return deriveDataGovV4Census(found.organizations, found.searches, recording.recordedAt.slice(0, 10));
}

export async function loadLatestDataGovV4Census(
  fixtureDirectory = resolve("fixtures/recorded"),
): Promise<DataGovV4Census | undefined> {
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
      if (recording.alias === "datagov-v4" && recording.mode === "catalog-census-v4" &&
        (latest === undefined || recording.recordedAt > latest.recordedAt)) latest = recording;
    } catch {
      // Ignore unrelated fixture files.
    }
  }
  return latest === undefined ? undefined : dataGovV4CensusFromRecording(latest);
}

export function legacyCkanRoundLine(status: number | undefined, probedOn: string): string | undefined {
  if (status !== 404) return undefined;
  return `Legacy CKAN endpoint returned 404 on ${probedOn}. The national catalog API moved to v4. Agents using stale docs fail here.`;
}

export const LEGACY_CKAN_EXPLAINER = {
  what: "Using a retired CKAN endpoint as the current national catalog API.",
  fix: "Publish API version and deprecation notices.",
  standard: "DCAT-US 3.0",
} as const;

export function formatDataGovV4National(census: DataGovV4Census | undefined): string {
  const value = (number: number | undefined): string => number === undefined ? "not available" : String(number);
  const types = census?.byType;
  return `${value(census?.publishers)} publishers | ${value(census?.datasets)} datasets | by type: Federal ${value(types?.Federal)}, State ${value(types?.State)}, City ${value(types?.City)}, County ${value(types?.County)} | Probed ${census?.probedOn ?? "not available"} | Not a ranking`;
}

export function formatDataGovV4Publisher(census: DataGovV4Census | undefined, name: string): string {
  if (!census) return `Publisher data not available in this API response. Probed not available | Not a ranking`;
  const term = DATAGOV_V4_PUBLISHER_TERMS.find((item) => item.toLowerCase() === name.toLowerCase());
  if (term && census.notInDataGov.includes(term)) return `${term} not in data.gov. Probed ${census.probedOn} | Not a ranking`;
  const matches = census.publishersBySearch.filter((publisher) =>
    publisher.name.toLowerCase().includes(name.toLowerCase()) || publisher.queryTerm.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 0) return `${name} not found among sampled publishers. Probed ${census.probedOn} | Not a ranking`;
  return matches.slice(0, 3).map((publisher) => {
    const datasetCount = publisher.datasetCount === undefined ? "dataset count not available" : `${publisher.datasetCount} datasets`;
    const sample = publisher.sampleCount === undefined
      ? "sample not available"
      : `Modeled: sample of ${publisher.sampleCount} records`;
    const share = publisher.sampleCount === undefined
      ? "license share not available"
      : publisher.licenseShare === undefined
        ? `license share not available in ${sample}`
        : `${(publisher.licenseShare * 100).toFixed(2)}% sampled records have dcat.license (${sample})`;
    return `${publisher.name}: ${datasetCount} | ${share}`;
  }).join("; ") + ` | Probed ${census.probedOn} | Not a ranking`;
}
