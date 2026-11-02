import type { CheckResult } from "./checks.js";
import type { AuditRecording } from "./fetcher.js";
import type { Target } from "../config.js";

export interface FixItField {
  field: "license" | "description" | "date";
  before: string;
  after: string;
}

export interface FixItCard {
  targetAlias: string;
  fixtureDate: string;
  recordTitle: string;
  fields: FixItField[];
}

interface RawRecord {
  title?: unknown;
  license?: unknown;
  description?: unknown;
  date?: unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordsFrom(text: string, dialect: Target["dialect"]): RawRecord[] {
  const root = object(JSON.parse(text) as unknown);
  if (root === undefined) return [];
  if (dialect === "ckan") {
    const result = object(root.result);
    const entries = Array.isArray(result?.results) ? result.results : [];
    return entries.map((value) => {
      const entry = object(value) ?? {};
      return {
        title: entry.title,
        license: entry.license_url ?? entry.license_id ?? entry.license_title,
        description: entry.notes,
        date: entry.metadata_modified ?? entry.metadata_created,
      };
    });
  }
  if (dialect === "socrata") {
    const entries = Array.isArray(root.results) ? root.results : [];
    return entries.map((value) => {
      const entry = object(value) ?? {};
      const resource = object(entry.resource) ?? {};
      const metadata = object(entry.metadata) ?? {};
      return {
        title: resource.name ?? resource.title ?? entry.title,
        license: metadata.license ?? entry.license,
        description: resource.description ?? entry.description,
        date: resource.updatedAt ?? resource.createdAt,
      };
    });
  }
  const entries = Array.isArray(root.dataset) ? root.dataset : Array.isArray(root["@graph"]) ? root["@graph"] as unknown[] : [];
  return entries.map((value) => {
    const entry = object(value) ?? {};
    return {
      title: entry.title,
      license: entry.license,
      description: entry.description,
      date: entry.modified ?? entry.issued,
    };
  });
}

function raw(value: unknown): string {
  if (value === undefined) return "(field absent)";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (value === null) return "null";
  return JSON.stringify(value);
}

function isBadLicense(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || /^tbd$/iu.test(text) || (!/^https?:\/\//iu.test(text) && !/^[a-z0-9.+-]+$/iu.test(text));
}

function isBadDescription(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const text = value.trim();
  return text === "" || text.length < 40 || /\{\{\s*description\s*\}\}/iu.test(text);
}

function isBadDate(value: unknown, probeDate: string): boolean {
  if (typeof value !== "string" || value.trim() === "") return true;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).getUTCFullYear() < 1990 || timestamp > Date.parse(`${probeDate}T23:59:59Z`)) return true;
  return timestamp < Date.parse(`${Number(probeDate.slice(0, 4)) - 5}${probeDate.slice(4)}T00:00:00Z`);
}

export function createFixItCard(
  target: Target,
  recording: AuditRecording | undefined,
  checks: readonly CheckResult[],
): FixItCard | undefined {
  if (target.mode !== "audit" || recording === undefined || target.catalogUrl === undefined || target.dialect === undefined) {
    return undefined;
  }
  const problemChecks = new Map<string, string>();
  for (const check of checks) {
    if (check.id === "D2" && ["prose", "empty_or_tbd", "not_found_in_sample"].includes(check.outcome)) problemChecks.set("license", check.outcome);
    if (check.id === "D3" && ["short", "empty_or_template", "not_found_in_sample"].includes(check.outcome)) problemChecks.set("description", check.outcome);
    if (check.id === "D4" && ["stale", "impossible", "not_found_in_sample"].includes(check.outcome)) problemChecks.set("date", check.outcome);
  }
  if (problemChecks.size === 0) return undefined;

  const exchange = recording.exchanges.find((item) => item.method === "GET" && item.url === target.catalogUrl);
  if (exchange === undefined || exchange.status < 200 || exchange.status >= 300) return undefined;
  let records: RawRecord[];
  try {
    records = recordsFrom(Buffer.from(exchange.body, exchange.bodyEncoding).toString("utf8"), target.dialect).slice(0, 50);
  } catch {
    return undefined;
  }
  if (records.length === 0) return undefined;

  const probeDate = recording.recordedAt.slice(0, 10);
  const needsFix = (record: RawRecord, field: string): boolean => {
    if (field === "license") return isBadLicense(record.license);
    if (field === "description") return isBadDescription(record.description);
    return isBadDate(record.date, probeDate);
  };
  const chosen = records
    .map((record) => ({ record, matched: [...problemChecks.keys()].filter((field) => needsFix(record, field)).length }))
    .sort((left, right) => right.matched - left.matched)[0]?.record;
  if (chosen === undefined) return undefined;

  const after: Record<string, string> = {
    license: "add the portal's actual license URL or SPDX identifier",
    description: "replace empty, short, or template text with a dataset description",
    date: "publish the actual metadata date from the source record",
  };
  const valueByField: Record<string, unknown> = {
    license: chosen.license,
    description: chosen.description,
    date: chosen.date,
  };
  return {
    targetAlias: target.alias,
    fixtureDate: probeDate,
    recordTitle: raw(chosen.title),
    fields: [...problemChecks.keys()].map((field) => ({
      field: field as FixItField["field"],
      before: raw(valueByField[field]),
      after: after[field] ?? "",
    })),
  };
}

export function formatFixItForChat(card: FixItCard): string {
  const fields = card.fields.map(({ field, before, after }) => `${field} before ${before}; after ${after}`).join(". ");
  return `Fix-it ${card.targetAlias} (${card.fixtureDate}), ${card.recordTitle}: ${fields}`;
}
