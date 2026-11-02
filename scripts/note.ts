import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAuditChecks } from "../src/audit/checks.js";
import { ReplayFetcher, type AuditRecording } from "../src/audit/fetcher.js";
import { createFixItCard } from "../src/audit/fixit.js";
import { getExplainer } from "../src/audit/explainers.js";
import { targets } from "../src/config.js";

async function main(): Promise<void> {
  const alias = process.argv[2]?.toLowerCase();
  const target = targets.find((item) => item.alias === alias);
  if (!alias || !target || process.argv.length !== 3) throw new Error("Usage: npm run note -- <alias>");
  const files = (await readdir(resolve("fixtures/recorded"))).filter((file) => file.endsWith(".json"));
  let recording: AuditRecording | undefined;
  for (const file of files) {
    const candidate = JSON.parse(await readFile(resolve("fixtures/recorded", file), "utf8")) as AuditRecording;
    if (candidate.alias === alias && (recording === undefined || candidate.recordedAt > recording.recordedAt)) recording = candidate;
  }
  const probeDate = recording?.recordedAt.slice(0, 10) ?? target.tos.reviewedOn;
  const fetcher = new ReplayFetcher({ recording, timeScale: 0 });
  const audit = await runAuditChecks(target, fetcher, () => new Date(`${probeDate}T12:00:00Z`));
  const fixes = createFixItCard(target, recording, audit.checks);
  const findings = audit.checks.map((check) => {
    const explanation = getExplainer(check.id, check.outcome);
    return `- ${check.id}: ${check.outcome} (${check.evidence}) Suggested fix: ${explanation.fix}`;
  });
  const fixLines = fixes?.fields.map((field) => `- ${field.field}: ${field.after}`) ?? [];
  const body = [
    `# A note about ${target.name}`,
    "",
    "Hello,",
    "",
    recording
      ? `We reviewed the locally recorded ${target.mode} sample dated ${probeDate}. This note describes only that sample.`
      : `The terms review is dated ${probeDate}; no fixture was needed for this terms-gated round.`,
    "",
    "Findings:",
    ...(findings.length ? findings : ["- No network check was run because the configured terms gate closed the door."]),
    "",
    "Possible fixes:",
    ...(fixLines.length ? fixLines : ["- No sampled D2, D3, or D4 fix was available from the fixture."]),
    "",
    `Terms status: ${target.tos.status}. Source: ${target.tos.sourceUrl}`,
    "",
    "Thank you for publishing public data and documenting how automated clients should access it.",
    "",
  ].join("\n");
  const directory = resolve("docs/notes");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${alias}.md`), body, "utf8");
  console.log(`Wrote docs/notes/${alias}.md from local fixture data. The note was not sent.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Note generation failed");
  process.exitCode = 1;
});
