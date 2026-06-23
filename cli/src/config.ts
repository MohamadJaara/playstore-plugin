import { existsSync } from "node:fs";
import { z } from "zod";

import { PlaystoreCliError } from "./utils/errors.js";

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

export function loadPlaystoreConfig(env: NodeJS.ProcessEnv = process.env): PlaystoreConfig {
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

export function inspectPlaystoreConfig(env: NodeJS.ProcessEnv = process.env): ConfigStatus {
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
