import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRecordingPathAvailable } from "../scripts/record.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("recording output preflight", () => {
  it("fails clearly when today's fixture already exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-ready-record-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "boston-2026-10-31.json");
    await writeFile(outputPath, "synthetic fixture");

    await expect(assertRecordingPathAvailable(outputPath))
      .rejects.toThrow("fixture exists, delete it to re-record");
  });
});
