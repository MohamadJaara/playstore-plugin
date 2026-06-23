import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/commands/doctor.js";
import { createCli } from "../src/index.js";

describe("doctor command", () => {
  it("passes local smoke checks in this repository", async () => {
    const report = await runDoctor();

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toContain("Plugin manifest");
    expect(report.checks.map((check) => check.name)).toContain("CLI wrapper");
  });
});

describe("CLI entrypoint", () => {
  it("registers the doctor command", () => {
    const cli = createCli();

    expect(cli.commands.map((command) => command.name())).toContain("doctor");
    expect(cli.commands.map((command) => command.name())).toContain("apps");
    expect(cli.commands.map((command) => command.name())).toContain("releases");
    expect(cli.commands.map((command) => command.name())).toContain("health");
    expect(cli.commands.map((command) => command.name())).toContain("issues");
    expect(cli.commands.map((command) => command.name())).toContain("anomalies");
    expect(cli.commands.map((command) => command.name())).toContain("reports");
    expect(cli.commands.map((command) => command.name())).toContain("report");
    expect(cli.commands.map((command) => command.name())).toContain("compare");
    expect(cli.commands.map((command) => command.name())).toContain("triage");
  });
});
