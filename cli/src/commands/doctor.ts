import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { inspectPlaystoreConfig } from "../config.js";
import { printJson, printMarkdown, type OutputFormat } from "../utils/output.js";

type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

interface DoctorOptions {
  format: OutputFormat;
}

const VALID_FORMATS = ["json", "markdown"] as const;

export function createDoctorCommand(): Command {
  const command = new Command("doctor");

  command
    .description("Validate the local Play Store plugin and CLI setup without contacting Google APIs.")
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: DoctorOptions) => {
      const format = normalizeFormat(options.format);
      const report = await runDoctor();

      if (format === "markdown") {
        printMarkdown(formatDoctorMarkdown(report));
      } else {
        printJson(report);
      }

      if (!report.ok) {
        process.exitCode = 1;
      }
    });

  return command;
}

export async function runDoctor(): Promise<DoctorReport> {
  const root = pluginRoot();
  const configStatus = inspectPlaystoreConfig();
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    await checkReadableJson(resolve(root, ".codex-plugin", "plugin.json"), "Plugin manifest"),
    await checkExecutable(resolve(root, "scripts", "playstore"), "CLI wrapper"),
    await checkReadableJson(resolve(root, "cli", "package.json"), "CLI package manifest"),
    checkCredentialStatus(configStatus.credentials),
    checkPackageAllowlistStatus(configStatus.packageAllowlist),
    checkDefaultPackageStatus(configStatus.defaultPackage)
  ];

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks
  };
}

function normalizeFormat(format: string): OutputFormat {
  if (VALID_FORMATS.includes(format as OutputFormat)) {
    return format as OutputFormat;
  }

  throw new Error(`Unsupported format "${format}". Expected one of: ${VALID_FORMATS.join(", ")}.`);
}

function checkNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const pass = major >= 20;

  return {
    name: "Node.js version",
    status: pass ? "pass" : "fail",
    message: pass
      ? `Node.js ${process.versions.node} satisfies the >=20 requirement.`
      : `Node.js ${process.versions.node} is too old. Install Node.js 20 or newer.`
  };
}

async function checkReadableJson(path: string, name: string): Promise<DoctorCheck> {
  try {
    JSON.parse(await readFile(path, "utf8"));
    return {
      name,
      status: "pass",
      message: `${path} exists and contains valid JSON.`
    };
  } catch (error) {
    return {
      name,
      status: "fail",
      message: `${path} could not be read as JSON: ${errorMessage(error)}`
    };
  }
}

async function checkExecutable(path: string, name: string): Promise<DoctorCheck> {
  try {
    await access(path, constants.X_OK);
    return {
      name,
      status: "pass",
      message: `${path} exists and is executable.`
    };
  } catch (error) {
    return {
      name,
      status: "fail",
      message: `${path} is not executable: ${errorMessage(error)}`
    };
  }
}

function checkCredentialStatus(credentials: ReturnType<typeof inspectPlaystoreConfig>["credentials"]): DoctorCheck {
  return {
    name: "Google credentials",
    status: credentials.configured ? "pass" : "warn",
    message: credentials.message
  };
}

function checkPackageAllowlistStatus(
  packageAllowlist: ReturnType<typeof inspectPlaystoreConfig>["packageAllowlist"]
): DoctorCheck {
  return {
    name: "Package allowlist",
    status: packageAllowlist.configured ? "pass" : "warn",
    message: packageAllowlist.message
  };
}

function checkDefaultPackageStatus(defaultPackage: ReturnType<typeof inspectPlaystoreConfig>["defaultPackage"]): DoctorCheck {
  let status: CheckStatus = "warn";

  if (defaultPackage.configured && defaultPackage.allowed) {
    status = "pass";
  } else if (defaultPackage.configured && !defaultPackage.allowed) {
    status = "fail";
  }

  return {
    name: "Default package",
    status,
    message: defaultPackage.message
  };
}

function formatDoctorMarkdown(report: DoctorReport): string {
  const rows = report.checks
    .map((check) => `| ${check.status} | ${check.name} | ${check.message} |`)
    .join("\n");

  return [
    "# Play Store CLI Doctor",
    "",
    report.ok ? "Status: pass" : "Status: fail",
    "",
    "| Status | Check | Message |",
    "| --- | --- | --- |",
    rows
  ].join("\n");
}

function pluginRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), "..", "..", "..");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
