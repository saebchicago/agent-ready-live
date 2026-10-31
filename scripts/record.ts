import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { targets } from "../src/config.js";
import { runAuditChecks } from "../src/audit/checks.js";
import {
  LiveFetcher,
  type AuditRecording,
  type RecordedExchange,
} from "../src/audit/fetcher.js";

function requiredEnv(name: "CONTACT_EMAIL" | "REPO_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const [alias, ...extra] = process.argv.slice(2);
  if (alias === undefined || extra.length > 0) {
    throw new Error("Usage: npm run record -- <alias>");
  }
  const target = targets.find((candidate) => candidate.alias === alias);
  if (target === undefined) throw new Error(`Unknown target alias ${JSON.stringify(alias)}`);

  const exchanges: RecordedExchange[] = [];
  const fetcher = new LiveFetcher({
    repoUrl: requiredEnv("REPO_URL"),
    contactEmail: requiredEnv("CONTACT_EMAIL"),
    onExchange: (exchange) => exchanges.push(exchange),
    onEvent: (event) => {
      if (event.type === "request") {
        console.log(`${event.method} ${event.path} ${event.status} ${event.ms}ms`);
      } else {
        console.log(`Waiting ${event.waitMs}ms for Crawl-delay on ${event.host}`);
      }
    },
  });
  const recordedAt = new Date().toISOString();
  const audit = await runAuditChecks(target, fetcher);
  const recording: AuditRecording = {
    schemaVersion: 1,
    alias: target.alias,
    mode: target.mode,
    recordedAt,
    exchanges,
  };
  const directory = resolve("fixtures/recorded");
  await mkdir(directory, { recursive: true });
  const date = recordedAt.slice(0, 10);
  const path = resolve(directory, `${target.alias}-${date}.json`);
  await writeFile(path, `${JSON.stringify(recording, null, 2)}\n`, { flag: "wx" });
  console.log(`Saved ${exchanges.length} raw exchanges to ${path}`);
  console.log(`Checks: ${audit.checks.map(({ id, outcome }) => `${id}=${outcome}`).join(", ")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Recording failed");
  process.exitCode = 1;
});
