import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { PlaystoreCliError } from "./utils/errors.js";

const DOTENV_FILE_NAME = ".env";

const envSchema = z.object({
  GOOGLE_APPLICATION_CREDENTIALS: z.string().trim().optional(),
  GOOGLE_AUTH_USE_ADC: z.string().trim().optional(),
  PLAYSTORE_DEFAULT_PACKAGE: z.string().trim().optional(),
  PLAYSTORE_PACKAGE_ALLOWLIST: z.string().trim().optional()
});

export interface PlaystoreConfig {
  credentialsFile?: string;
  useApplicationDefaultCredentials: boolean;
  defaultPackage?: string;
  packageAllowlist: string[];
}

export interface ConfigStatus {
  credentials: {
    configured: boolean;
    source: "service-account-file" | "application-default" | "none";
    message: string;
  };
  packageAllowlist: {
    configured: boolean;
    packages: string[];
    message: string;
  };
  defaultPackage: {
    configured: boolean;
    packageName?: string;
    allowed: boolean;
    message: string;
  };
}

export function loadPlaystoreConfig(env: NodeJS.ProcessEnv = loadPlaystoreEnv()): PlaystoreConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    throw new PlaystoreCliError(
      "INVALID_CONFIG",
      "Environment configuration could not be parsed.",
      "Check Play Store CLI environment variables for invalid values."
    );
  }

  const config = parseConfig(parsed.data);
  validateCredentials(config);
  validatePackageAllowlist(config);
  validateDefaultPackage(config);

  return config;
}

export function inspectPlaystoreConfig(env: NodeJS.ProcessEnv = loadPlaystoreEnv()): ConfigStatus {
  const config = parseConfig(envSchema.parse(env));
  const credentials = inspectCredentials(config);
  const packageAllowlist = inspectPackageAllowlist(config);
  const defaultPackage = inspectDefaultPackage(config);

  return {
    credentials,
    packageAllowlist,
    defaultPackage
  };
}

export function loadPlaystoreEnv(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath = defaultEnvFilePath()
): NodeJS.ProcessEnv {
  return mergeEnv(readDotenvFile(envFilePath), env);
}

export function assertPackageAllowed(packageName: string, config: PlaystoreConfig): void {
  validatePackageAllowlist(config);

  if (!config.packageAllowlist.includes(packageName)) {
    throw new PlaystoreCliError(
      "PACKAGE_NOT_ALLOWED",
      `Package "${packageName}" is not in PLAYSTORE_PACKAGE_ALLOWLIST.`,
      "Add the package to PLAYSTORE_PACKAGE_ALLOWLIST before running commands that access Google Play data."
    );
  }
}

function parseConfig(env: z.infer<typeof envSchema>): PlaystoreConfig {
  const credentialsFile = emptyToUndefined(env.GOOGLE_APPLICATION_CREDENTIALS);
  const defaultPackage = emptyToUndefined(env.PLAYSTORE_DEFAULT_PACKAGE);
  const packageAllowlist = parsePackageAllowlist(env.PLAYSTORE_PACKAGE_ALLOWLIST);

  return {
    credentialsFile,
    useApplicationDefaultCredentials: parseBoolean(env.GOOGLE_AUTH_USE_ADC),
    defaultPackage,
    packageAllowlist
  };
}

function validateCredentials(config: PlaystoreConfig): void {
  if (!config.credentialsFile && !config.useApplicationDefaultCredentials) {
    throw new PlaystoreCliError(
      "MISSING_CREDENTIALS",
      "No Google credentials are configured.",
      "Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file or set GOOGLE_AUTH_USE_ADC=true to use application-default credentials."
    );
  }
}

function validatePackageAllowlist(config: PlaystoreConfig): void {
  if (config.packageAllowlist.length === 0) {
    throw new PlaystoreCliError(
      "MISSING_PACKAGE_ALLOWLIST",
      "PLAYSTORE_PACKAGE_ALLOWLIST is not configured.",
      "Set PLAYSTORE_PACKAGE_ALLOWLIST to a comma-separated list of package names that this read-only CLI may inspect."
    );
  }
}

function validateDefaultPackage(config: PlaystoreConfig): void {
  if (config.defaultPackage) {
    assertPackageAllowed(config.defaultPackage, config);
  }
}

function inspectCredentials(config: PlaystoreConfig): ConfigStatus["credentials"] {
  if (config.credentialsFile) {
    const exists = existsSync(config.credentialsFile);
    return {
      configured: exists,
      source: "service-account-file",
      message: exists
        ? "GOOGLE_APPLICATION_CREDENTIALS points to a readable local path. The path is not shown to avoid leaking local secret locations."
        : "GOOGLE_APPLICATION_CREDENTIALS is set, but the referenced file was not found."
    };
  }

  if (config.useApplicationDefaultCredentials) {
    return {
      configured: true,
      source: "application-default",
      message: "GOOGLE_AUTH_USE_ADC=true is set. Doctor does not contact Google APIs to verify the account."
    };
  }

  return {
    configured: false,
    source: "none",
    message: "No credentials configured. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_AUTH_USE_ADC=true."
  };
}

function inspectPackageAllowlist(config: PlaystoreConfig): ConfigStatus["packageAllowlist"] {
  if (config.packageAllowlist.length === 0) {
    return {
      configured: false,
      packages: [],
      message: "PLAYSTORE_PACKAGE_ALLOWLIST is not configured."
    };
  }

  return {
    configured: true,
    packages: config.packageAllowlist,
    message: `${config.packageAllowlist.length} package name(s) are allowed.`
  };
}

function inspectDefaultPackage(config: PlaystoreConfig): ConfigStatus["defaultPackage"] {
  if (!config.defaultPackage) {
    return {
      configured: false,
      allowed: false,
      message: "PLAYSTORE_DEFAULT_PACKAGE is not configured."
    };
  }

  const allowed = config.packageAllowlist.includes(config.defaultPackage);

  return {
    configured: true,
    packageName: config.defaultPackage,
    allowed,
    message: allowed
      ? "PLAYSTORE_DEFAULT_PACKAGE is present in the allowlist."
      : "PLAYSTORE_DEFAULT_PACKAGE is not present in PLAYSTORE_PACKAGE_ALLOWLIST."
  };
}

function parsePackageAllowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function readDotenvFile(path: string): NodeJS.ProcessEnv {
  if (!existsSync(path)) {
    return {};
  }

  try {
    return parseDotenv(readFileSync(path, "utf8"), path);
  } catch (error) {
    if (error instanceof PlaystoreCliError) {
      throw error;
    }

    throw new PlaystoreCliError(
      "INVALID_DOTENV",
      `${DOTENV_FILE_NAME} configuration could not be read.`,
      `Check ${path} permissions and syntax.`
    );
  }
}

function parseDotenv(content: string, path: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};

  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : line;
    const equalsIndex = assignment.indexOf("=");

    if (equalsIndex === -1) {
      throw invalidDotenvLine(path, index + 1);
    }

    const key = assignment.slice(0, equalsIndex).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw invalidDotenvLine(path, index + 1);
    }

    values[key] = parseDotenvValue(assignment.slice(equalsIndex + 1), path, index + 1);
  });

  return values;
}

function parseDotenvValue(value: string, path: string, lineNumber: number): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return "";
  }

  const quote = trimmed[0];

  if (quote === "'" || quote === '"') {
    const closingIndex = findClosingQuote(trimmed, quote);

    if (closingIndex === -1) {
      throw invalidDotenvLine(path, lineNumber);
    }

    const quoted = trimmed.slice(1, closingIndex);
    return quote === '"' ? unescapeDoubleQuotedValue(quoted) : quoted;
  }

  return stripInlineComment(trimmed).trimEnd();
}

function findClosingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === quote && (quote === "'" || value[index - 1] !== "\\")) {
      return index;
    }
  }

  return -1;
}

function unescapeDoubleQuotedValue(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function stripInlineComment(value: string): string {
  const commentIndex = value.search(/\s#/);
  return commentIndex === -1 ? value : value.slice(0, commentIndex);
}

function mergeEnv(dotenvEnv: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...dotenvEnv };

  Object.entries(env).forEach(([key, value]) => {
    if (value !== undefined) {
      merged[key] = value;
    }
  });

  return merged;
}

function defaultEnvFilePath(): string {
  return resolve(pluginRoot(), DOTENV_FILE_NAME);
}

function pluginRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function invalidDotenvLine(path: string, lineNumber: number): PlaystoreCliError {
  return new PlaystoreCliError(
    "INVALID_DOTENV",
    `${DOTENV_FILE_NAME} contains an invalid assignment on line ${lineNumber}.`,
    `Use KEY=value syntax in ${path}.`
  );
}
