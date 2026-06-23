import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "fixtures");

const expectedTopLevelKeys = new Map<string, string>([
  ["play-publisher-releases-production.json", "releases"],
  ["play-publisher-reviews.json", "reviews"],
  ["reporting-anr-metrics-query.json", "rows"],
  ["reporting-crash-metrics-query.json", "rows"],
  ["reporting-anomalies.json", "anomalies"],
  ["reporting-error-issues.json", "errorIssues"],
  ["reporting-error-reports.json", "errorReports"]
]);

describe("example fixtures", () => {
  it("keeps every mocked API fixture valid JSON with the expected response key", async () => {
    const files = (await readdir(fixtureDirectory)).filter((file) => file.endsWith(".json")).sort();

    expect(files).toEqual([...expectedTopLevelKeys.keys()].sort());

    for (const file of files) {
      const parsed = JSON.parse(await readFile(join(fixtureDirectory, file), "utf8")) as Record<string, unknown>;
      const expectedKey = expectedTopLevelKeys.get(file);

      expect(parsed).toHaveProperty(expectedKey as string);
      expect(Array.isArray(parsed[expectedKey as string])).toBe(true);
    }
  });
});
