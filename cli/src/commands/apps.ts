import { Command } from "commander";

import { loadPlaystoreConfig } from "../config.js";
import { appsListInputSchema } from "../schemas/cliInputs.js";
import { appsListOutputSchema, type AppsListOutput } from "../schemas/cliOutputs.js";
import { printJson, printMarkdown } from "../utils/output.js";

export function createAppsCommand(): Command {
  const command = new Command("apps");

  command.description("Discover configured Google Play apps that this read-only CLI may inspect.");
  command.addCommand(createAppsListCommand());

  return command;
}

export function createAppsListCommand(): Command {
  const command = new Command("list");

  command
    .description("List packages from PLAYSTORE_PACKAGE_ALLOWLIST.")
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: { format: string }) => {
      const input = appsListInputSchema.parse(options);
      const output = listConfiguredApps();

      if (input.format === "markdown") {
        printMarkdown(formatAppsMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export function listConfiguredApps(): AppsListOutput {
  const config = loadPlaystoreConfig();

  return appsListOutputSchema.parse({
    apps: config.packageAllowlist.map((packageName) => ({ packageName }))
  });
}

function formatAppsMarkdown(output: AppsListOutput): string {
  const rows = output.apps.map((app) => `| ${app.packageName} |`).join("\n");

  return ["# Play Store Apps", "", "| Package |", "| --- |", rows || "| _none_ |"].join("\n");
}
