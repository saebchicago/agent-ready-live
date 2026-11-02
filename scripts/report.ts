import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAuditChecks } from "../src/audit/checks.js";
import { ReplayFetcher, type AuditRecording } from "../src/audit/fetcher.js";
import { targets } from "../src/config.js";
import { classifyDoorLadder } from "../src/audit/ladder.js";
import { deriveNationalCensus, exchangesForCensus } from "../src/audit/census.js";
import { dataGovV4CensusFromRecording, formatDataGovV4National } from "../src/audit/census-v4.js";

async function main(): Promise<void> {
  const fixtureDirectory = resolve("fixtures/recorded");
  const files = (await readdir(fixtureDirectory)).filter((name) => name.endsWith(".json"));
  const recordingByAlias = new Map<string, AuditRecording>();
  for (const file of files) {
    const recording = JSON.parse(await readFile(resolve(fixtureDirectory, file), "utf8")) as AuditRecording;
    const prior = recordingByAlias.get(recording.alias);
    if (prior === undefined || recording.recordedAt > prior.recordedAt) {
      recordingByAlias.set(recording.alias, recording);
    }
  }

  const rows: string[] = [];
  for (const target of targets) {
    const recording = recordingByAlias.get(target.alias);
    const probeDate = recording?.recordedAt.slice(0, 10) ?? target.tos.reviewedOn;
    if (target.mode === "catalog-census") {
      const { callA, callB } = recording ? exchangesForCensus(recording) : {};
      const census = deriveNationalCensus(callA, callB, recording?.recordedAt.slice(0, 10) ?? "not available", Boolean(callA?.truncated || callB?.truncated), recording?.censusError);
      const censusFacts = recording === undefined
        ? "No local census fixture is recorded"
        : `${census.legacyRoundLine ?? `Total ${census.totalDatasets ?? "not available in this catalog"}; licenses ${census.licenseFacetAvailable ? census.licenses.length : "not available in this catalog"}; publishers ${census.publishersAvailable ? census.publishers.length : "not available in this catalog"}`}${census.truncated ? `; ${[callA?.truncated ? "Call A" : "", callB?.truncated ? "Call B" : ""].filter(Boolean).join(" and ") || "Census response"} truncated at 5 MB` : ""}`;
      const statement = `Probed ${recording?.recordedAt.slice(0, 10) ?? "not available"} | Not a ranking`;
      rows.push(`| ${target.alias} | ${target.mode} | ${target.tos.status} | National lens | ${censusFacts} | ${statement} |`);
      continue;
    }
    if (target.mode === "catalog-census-v4") {
      const census = recording === undefined ? undefined : dataGovV4CensusFromRecording(recording);
      const censusFacts = census === undefined ? "No local v4 census fixture is recorded" : formatDataGovV4National(census);
      rows.push(`| ${target.alias} | ${target.mode} | ${target.tos.status} | National lens | ${censusFacts.replaceAll("|", "\\|")} | ${`Probed ${census?.probedOn ?? "not available"} | Not a ranking`.replaceAll("|", "\\|")} |`);
      continue;
    }
    const fetcher = new ReplayFetcher({
      recording,
      timeScale: 0,
      ...(recording === undefined ? { fixturesDir: resolve("tests/fixtures/synthetic/no-recordings") } : {}),
    });
    const audit = await runAuditChecks(target, fetcher, () => new Date(`${probeDate}T12:00:00Z`));
    const checks = audit.checks.map(({ id, outcome }) => `${id}=${outcome}`).join("; ");
    const sample = target.mode === "knock"
      ? "Knock only: no catalog sampled"
      : `Sampled ${audit.sampledEntries}`;
    const statement = `${sample} | Probed ${probeDate} | Rubric v1 | Not a ranking of agency quality`
      .replaceAll("|", "\\|");
    const ladder = classifyDoorLadder(target, audit.checks).step;
    rows.push(`| ${target.alias} | ${target.mode} | ${target.tos.status} | ${ladder} | ${checks || "not found in sample"} | ${statement} |`);
  }

  const output = [
    "# Results",
    "",
    "Generated from `config/targets.json` and the latest local recording for each target. No live requests are made by this report command.",
    "",
    "Check outcomes summarize only the recorded sample. Missing recordings are reported as `not found in sample` through the terms or check results.",
    "",
    "| Target | Mode | Terms status | Door ladder | Check outcomes | Sample and probe |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Needs source",
    "",
    "- City of Boston Open Context MCP server URL.",
    "- Official Twitch API and EventSub URL.",
    "- Michigan approved route URL; the configured note says a reply is pending.",
    "- France and EU context source URL for the between-round card.",
    "- ArcGIS Hub publisher DCAT-US feed URL.",
    "",
  ].join("\n").replace(/\n+$/u, "\n");
  await writeFile(resolve("docs/RESULTS.md"), output, "utf8");
  console.log(`Generated docs/RESULTS.md for ${rows.length} configured targets from local fixtures.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Report generation failed");
  process.exitCode = 1;
});
