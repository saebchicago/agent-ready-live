import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { targets } from "../src/config.js";
import { runAuditChecks } from "../src/audit/checks.js";
import { censusRequestUrls } from "../src/audit/census.js";
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

export async function assertRecordingPathAvailable(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`fixture exists, delete it to re-record: ${path}`);
}

export async function main(): Promise<void> {
  const [alias, ...extra] = process.argv.slice(2);
  if (alias === undefined || extra.length > 0) {
    throw new Error("Usage: npm run record -- <alias>");
  }
  const target = targets.find((candidate) => candidate.alias === alias);
  if (target === undefined) throw new Error(`Unknown target alias ${JSON.stringify(alias)}`);

  const recordedAt = new Date().toISOString();
  const directory = resolve("fixtures/recorded");
  const date = recordedAt.slice(0, 10);
  const path = resolve(directory, `${target.alias}-${date}.json`);
  await assertRecordingPathAvailable(path);

  const exchanges: RecordedExchange[] = [];
  let censusError: string | undefined;
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
  let audit: Awaited<ReturnType<typeof runAuditChecks>> | undefined;
  if (target.mode === "catalog-census") {
    await fetcher.runAudit(target, async (session) => {
      let policy;
      try {
        policy = await session.robots();
      } catch (error) {
        censusError = error instanceof Error ? error.message : "Robots request failed safely.";
        return;
      }
      if (policy.stopped) return;
      const [callA, callB] = censusRequestUrls(target);
      for (const url of [callA, callB]) {
        if (!policy.isAllowed(url)) break;
        try {
          const response = await session.request(url, "GET");
          if (response.status >= 400) break;
        } catch (error) {
          censusError = error instanceof Error ? error.message : "Census request failed safely.";
          break;
        }
      }
    });
  } else {
    audit = await runAuditChecks(target, fetcher);
  }
  const recording: AuditRecording = {
    schemaVersion: 1,
    alias: target.alias,
    mode: target.mode,
    recordedAt,
    sanitized: ["set-cookie", "cookie"],
    exchanges,
    ...(censusError === undefined ? {} : { censusError }),
  };
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(recording, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new Error(`fixture exists, delete it to re-record: ${path}`);
    }
    throw error;
  }
  console.log(`Saved ${exchanges.length} raw exchanges to ${path}`);
  if (audit !== undefined) console.log(`Checks: ${audit.checks.map(({ id, outcome }) => `${id}=${outcome}`).join(", ")}`);
  if (censusError !== undefined) console.log(`Census stopped safely: ${censusError}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Recording failed");
    process.exitCode = 1;
  });
}
