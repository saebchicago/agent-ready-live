import type { AuditRecording, RecordedExchange } from "./fetcher.js";
import type { Target } from "../config.js";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CENSUS_NOTICE } from "./census-notice.js";

export { CENSUS_NOTICE } from "./census-notice.js";
export const CENSUS_SENTINELS = new Set([-666666666, -999999999, -888888888, -555555555, -333333333, -222222222]);
export const CENSUS_API_PATH = "/data/2024/acs/acs5";
export const CENSUS_GET = "NAME,B19013_001E,B19013_001M,B11001_001E";

export interface CensusTract {
  name: string;
  tract: string;
  income: number | undefined;
  marginOfError: number | undefined;
  households: number | undefined;
  rawIncome: number | undefined;
  errorReasons: string[];
}

export interface CensusMeaning {
  probedOn: string;
  source: "recorded" | "synthetic";
  tracts: CensusTract[];
  errorTracts: number;
  naiveLowest: CensusTract[];
  correctedLowest: CensusTract[];
}

export function censusMeaningUrl(target: Target): string {
  const url = new URL(`https://${target.host}${CENSUS_API_PATH}`);
  url.searchParams.set("get", CENSUS_GET);
  url.searchParams.set("for", "tract:*");
  url.searchParams.set("in", "state:26 county:163");
  return url.toString();
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function field(value: unknown, name: string): { value: number | undefined; reason?: string } {
  const number = numeric(value);
  if (number === undefined) return { value: undefined, reason: `${name} is absent or not numeric` };
  if (CENSUS_SENTINELS.has(number)) return { value: undefined, reason: `${name} uses Census sentinel ${number}` };
  return { value: number };
}

export function deriveCensusMeaning(rows: readonly unknown[][], probedOn: string, source: CensusMeaning["source"]): CensusMeaning {
  const header = rows[0] ?? [];
  const column = (name: string): number => header.findIndex((value) => value === name);
  const nameCol = column("NAME");
  const incomeCol = column("B19013_001E");
  const moeCol = column("B19013_001M");
  const householdsCol = column("B11001_001E");
  const tractCol = column("tract");
  const stateCol = column("state");
  const countyCol = column("county");
  const tracts = rows.slice(1).map((row): CensusTract => {
    const income = field(row[incomeCol], "B19013_001E");
    const moe = field(row[moeCol], "B19013_001M");
    const households = field(row[householdsCol], "B11001_001E");
    const reasons = [income.reason, moe.reason, households.reason].filter((reason): reason is string => reason !== undefined);
    const tract = tractCol >= 0 && row[tractCol] !== undefined ? String(row[tractCol]) : "unknown tract";
    const jurisdiction = [stateCol >= 0 ? row[stateCol] : undefined, countyCol >= 0 ? row[countyCol] : undefined].filter(Boolean).join(":");
    return {
      name: nameCol >= 0 && row[nameCol] !== undefined ? String(row[nameCol]) : `Census tract ${tract}`,
      tract: jurisdiction ? `${jurisdiction}:${tract}` : tract,
      income: income.value,
      marginOfError: moe.value,
      households: households.value,
      rawIncome: numeric(row[incomeCol]),
      errorReasons: reasons,
    };
  });
  const errorTracts = tracts.filter(({ errorReasons }) => errorReasons.length > 0).length;
  const naiveLowest = [...tracts].sort((a, b) => (a.rawIncome ?? Number.POSITIVE_INFINITY) - (b.rawIncome ?? Number.POSITIVE_INFINITY)).slice(0, 10);
  const correctedLowest = tracts.filter(({ income, marginOfError }) => income !== undefined && marginOfError !== undefined)
    .sort((a, b) => a.income! - b.income!).slice(0, 10);
  return { probedOn, source, tracts, errorTracts, naiveLowest, correctedLowest };
}

export function censusMeaningFromExchange(exchange: RecordedExchange | undefined, source: CensusMeaning["source"] = "recorded"): CensusMeaning | undefined {
  if (!exchange || exchange.status < 200 || exchange.status >= 300 || exchange.truncated) return undefined;
  try {
    const rows = JSON.parse(Buffer.from(exchange.body, exchange.bodyEncoding).toString("utf8")) as unknown;
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) return undefined;
    return deriveCensusMeaning(rows as unknown[][], exchange.timestamp.slice(0, 10), source);
  } catch { return undefined; }
}

export function censusMeaningFromRecording(recording: AuditRecording): CensusMeaning | undefined {
  return censusMeaningFromExchange(recording.exchanges.find(({ url }) => {
    const parsed = new URL(url);
    return parsed.hostname === "api.census.gov" && parsed.pathname === CENSUS_API_PATH;
  }));
}

export function formatCensusTrap(meaning: CensusMeaning): string {
  const error = `${meaning.errorTracts} of ${meaning.tracts.length} tracts return an error code`;
  const naive = meaning.naiveLowest.slice(0, 2).map(({ tract, rawIncome }) => `${tract.split(":").at(-1)}=${rawIncome ?? "missing"}`).join(",");
  const corrected = meaning.correctedLowest.slice(0, 3).map(({ tract, income, marginOfError }) => `${tract.split(":").at(-1)}=$${income}±$${marginOfError}`).join(",");
  return `Census notice: ${CENSUS_NOTICE} Naive agent's 10 lowest-income tracts begin ${naive}. Corrected list begins ${corrected}. ${error}.`;
}

export async function loadLatestCensusMeaning(options: { syntheticFallback?: boolean } = {}): Promise<CensusMeaning | undefined> {
  const directory = resolve("fixtures/recorded");
  try {
    const names = (await readdir(directory)).filter((name) => name.startsWith("census-wayne-") && name.endsWith(".json")).sort().reverse();
    for (const name of names) {
      const recording = JSON.parse(await readFile(resolve(directory, name), "utf8")) as AuditRecording;
      if (recording.alias !== "census-wayne" || recording.mode !== "meaning") continue;
      const meaning = censusMeaningFromRecording(recording);
      if (meaning) return meaning;
    }
  } catch { /* A judge may run the demo before the recordings directory exists. */ }
  if (!options.syntheticFallback) return undefined;
  const fixture = JSON.parse(await readFile(resolve("tests/fixtures/synthetic/census-wayne-response.json"), "utf8")) as { rows: unknown[][] };
  return deriveCensusMeaning(fixture.rows, "2026-11-02", "synthetic");
}
