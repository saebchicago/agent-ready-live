import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAuditChecks } from "../src/audit/checks.js";
import { ReplayFetcher, type AuditRecording } from "../src/audit/fetcher.js";
import { targets } from "../src/config.js";

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
    rows.push(`| ${target.alias} | ${target.mode} | ${target.tos.status} | ${checks || "not found in sample"} | ${statement} |`);
  }

  const output = [
    "# Results",
    "",
    "Generated from `config/targets.json` and the latest local recording for each target. No live requests are made by this report command.",
    "",
    "Check outcomes summarize only the recorded sample. Missing recordings are reported as `not found in sample` through the terms or check results.",
    "",
    "| Target | Mode | Terms status | Check outcomes | Sample and probe |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  await writeFile(resolve("docs/RESULTS.md"), output, "utf8");
  console.log(`Generated docs/RESULTS.md for ${rows.length} configured targets from local fixtures.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Report generation failed");
  process.exitCode = 1;
});
