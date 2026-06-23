#!/usr/bin/env node
import { Command } from "commander";

import { createAnomaliesCommand } from "./commands/anomalies.js";
import { createAppsCommand } from "./commands/apps.js";
import { createCompareCommand } from "./commands/compare.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createHealthCommand } from "./commands/health.js";
import { createIssuesCommand } from "./commands/issues.js";
import { createReportCommand } from "./commands/report.js";
import { createReleasesCommand } from "./commands/releases.js";
import { createReportsCommand } from "./commands/reports.js";
import { createReviewsCommand } from "./commands/reviews.js";
import { createTriageCommand } from "./commands/triage.js";
import { formatCliError } from "./utils/errors.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("playstore")
    .description("Read-only Google Play investigation CLI for the Play Store Codex plugin.")
    .version("0.1.0");

  program.addCommand(createDoctorCommand());
  program.addCommand(createAppsCommand());
  program.addCommand(createReleasesCommand());
  program.addCommand(createHealthCommand());
  program.addCommand(createIssuesCommand());
  program.addCommand(createAnomaliesCommand());
  program.addCommand(createReportsCommand());
  program.addCommand(createReportCommand());
  program.addCommand(createCompareCommand());
  program.addCommand(createTriageCommand());
  program.addCommand(createReviewsCommand());

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await createCli().parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error: unknown) => {
    console.error(`playstore: ${formatCliError(error)}`);
    process.exitCode = 1;
  });
}
