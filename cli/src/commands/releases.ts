import { Command } from "commander";

import { createAuthenticatedClient } from "../auth/googleAuth.js";
import { createPlayPublisherClient, type PlayPublisherClient } from "../clients/playPublisherClient.js";
import { assertPackageAllowed, loadPlaystoreConfig, type PlaystoreConfig } from "../config.js";
import { selectLatestRelease, summarizeRelease } from "../domain/releases.js";
import { releasesListInputSchema, type ReleasesListInput } from "../schemas/cliInputs.js";
import { releasesListOutputSchema, type ReleaseSummary, type ReleasesListOutput } from "../schemas/cliOutputs.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { printJson, printMarkdown } from "../utils/output.js";

export function createReleasesCommand(): Command {
  const command = new Command("releases");

  command.description("Discover Google Play releases for an allowed package and track.");
  command.addCommand(createReleasesListCommand());

  return command;
}

export function createReleasesListCommand(): Command {
  const command = new Command("list");

  command
    .description("List releases for a package track.")
    .option("--package <packageName>", "Package name. Defaults to PLAYSTORE_DEFAULT_PACKAGE.")
    .option("--track <track>", "Track name such as production, beta, or internal.", "production")
    .option("--latest", "Return only the latest release candidate in the latest field.", false)
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: { package?: string; track: string; latest: boolean; format: string }) => {
      const input = releasesListInputSchema.parse({
        packageName: options.package,
        track: options.track,
        latest: options.latest,
        format: options.format
      });
      const output = await listReleases(input);
      const displayOutput = input.latest
        ? releasesListOutputSchema.parse({ ...output, releases: output.latest ? [output.latest] : [] })
        : output;

      if (input.format === "markdown") {
        printMarkdown(formatReleasesMarkdown(displayOutput));
      } else {
        printJson(displayOutput);
      }
    });

  return command;
}

export async function listReleases(
  input: ReleasesListInput,
  dependencies: {
    config?: PlaystoreConfig;
    client?: PlayPublisherClient;
  } = {}
): Promise<ReleasesListOutput> {
  const config = dependencies.config ?? loadPlaystoreConfig();
  const packageName = resolvePackageName(input.packageName, config);

  assertPackageAllowed(packageName, config);

  const client = dependencies.client ?? createPlayPublisherClient(await createAuthenticatedClient(config));
  const releases = (await client.listReleases(packageName, input.track)).map((release) =>
    summarizeRelease(packageName, input.track, release)
  );
  const latest = selectLatestRelease(releases);

  return releasesListOutputSchema.parse({
    packageName,
    track: input.track,
    releases,
    ...(latest ? { latest } : {})
  });
}

function resolvePackageName(packageName: string | undefined, config: PlaystoreConfig): string {
  if (packageName) {
    return packageName;
  }

  if (config.defaultPackage) {
    return config.defaultPackage;
  }

  throw new PlaystoreCliError(
    "INVALID_CONFIG",
    "No package was provided and PLAYSTORE_DEFAULT_PACKAGE is not configured.",
    "Pass --package or set PLAYSTORE_DEFAULT_PACKAGE to an allowed package name."
  );
}

function formatReleasesMarkdown(output: ReleasesListOutput): string {
  const rows = output.releases.map(formatReleaseRow).join("\n");

  return [
    `# Play Store Releases`,
    "",
    `Package: ${output.packageName}`,
    `Track: ${output.track}`,
    "",
    "| Release | Version codes | Status | Rollout fraction |",
    "| --- | --- | --- | --- |",
    rows || "| _none_ | _none_ | _none_ | _none_ |"
  ].join("\n");
}

function formatReleaseRow(release: ReleaseSummary): string {
  return `| ${release.releaseName ?? "_unnamed_"} | ${release.versionCodes.join(", ") || "_none_"} | ${
    release.status ?? "_unknown_"
  } | ${release.rolloutFraction ?? "_n/a_"} |`;
}
