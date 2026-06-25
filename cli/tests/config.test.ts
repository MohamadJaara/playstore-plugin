import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertPackageAllowed,
  inspectPlaystoreConfig,
  loadPlaystoreConfig,
  loadPlaystoreEnv,
  type PlaystoreConfig
} from "../src/config.js";
import { createAuthenticatedClient, createGoogleAuth } from "../src/auth/googleAuth.js";
import { PlaystoreCliError } from "../src/utils/errors.js";

describe("loadPlaystoreConfig", () => {
  it("loads credentials, allowlist, and default package from environment variables", () => {
    const config = loadPlaystoreConfig({
      GOOGLE_AUTH_USE_ADC: "true",
      PLAYSTORE_PACKAGE_ALLOWLIST: "com.example.app, com.example.beta",
      PLAYSTORE_DEFAULT_PACKAGE: "com.example.app"
    });

    expect(config).toEqual({
      credentialsFile: undefined,
      useApplicationDefaultCredentials: true,
      defaultPackage: "com.example.app",
      packageAllowlist: ["com.example.app", "com.example.beta"]
    });
  });

  it("loads configuration from a plugin .env file", async () => {
    const envPath = await writeTempEnv([
      "# Google Play CLI configuration",
      "GOOGLE_AUTH_USE_ADC=true",
      'PLAYSTORE_PACKAGE_ALLOWLIST="com.example.app, com.example.beta"',
      "export PLAYSTORE_DEFAULT_PACKAGE=com.example.app # optional default"
    ]);

    try {
      const env = loadPlaystoreEnv({}, envPath.path);
      const config = loadPlaystoreConfig(env);

      expect(config).toEqual({
        credentialsFile: undefined,
        useApplicationDefaultCredentials: true,
        defaultPackage: "com.example.app",
        packageAllowlist: ["com.example.app", "com.example.beta"]
      });
    } finally {
      await envPath.cleanup();
    }
  });

  it("lets process environment values override .env values", async () => {
    const envPath = await writeTempEnv([
      "GOOGLE_AUTH_USE_ADC=false",
      "PLAYSTORE_PACKAGE_ALLOWLIST=com.example.fromfile",
      "PLAYSTORE_DEFAULT_PACKAGE=com.example.fromfile"
    ]);

    try {
      const env = loadPlaystoreEnv(
        {
          GOOGLE_AUTH_USE_ADC: "true",
          PLAYSTORE_PACKAGE_ALLOWLIST: "com.example.shell",
          PLAYSTORE_DEFAULT_PACKAGE: "com.example.shell"
        },
        envPath.path
      );
      const config = loadPlaystoreConfig(env);

      expect(config).toMatchObject({
        useApplicationDefaultCredentials: true,
        defaultPackage: "com.example.shell",
        packageAllowlist: ["com.example.shell"]
      });
    } finally {
      await envPath.cleanup();
    }
  });

  it("fails with an actionable error when .env syntax is invalid", async () => {
    const envPath = await writeTempEnv(["not a valid assignment"]);

    try {
      expect(() => loadPlaystoreEnv({}, envPath.path)).toThrow(
        expect.objectContaining({
          code: "INVALID_DOTENV",
          hint: expect.stringContaining("KEY=value")
        })
      );
    } finally {
      await envPath.cleanup();
    }
  });

  it("fails with an actionable error when credentials are missing", () => {
    expect(() =>
      loadPlaystoreConfig({
        PLAYSTORE_PACKAGE_ALLOWLIST: "com.example.app"
      })
    ).toThrow(PlaystoreCliError);

    try {
      loadPlaystoreConfig({
        PLAYSTORE_PACKAGE_ALLOWLIST: "com.example.app"
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "MISSING_CREDENTIALS",
        hint: expect.stringContaining("GOOGLE_APPLICATION_CREDENTIALS")
      });
    }
  });

  it("fails when the package allowlist is missing", () => {
    expect(() =>
      loadPlaystoreConfig({
        GOOGLE_AUTH_USE_ADC: "true"
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_PACKAGE_ALLOWLIST" }));
  });

  it("rejects a default package outside the allowlist", () => {
    expect(() =>
      loadPlaystoreConfig({
        GOOGLE_AUTH_USE_ADC: "true",
        PLAYSTORE_PACKAGE_ALLOWLIST: "com.example.allowed",
        PLAYSTORE_DEFAULT_PACKAGE: "com.example.blocked"
      })
    ).toThrow(expect.objectContaining({ code: "PACKAGE_NOT_ALLOWED" }));
  });
});

async function writeTempEnv(lines: string[]): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "playstore-env-"));
  const path = join(dir, ".env");

  await writeFile(path, `${lines.join("\n")}\n`, "utf8");

  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

describe("assertPackageAllowed", () => {
  const config: PlaystoreConfig = {
    useApplicationDefaultCredentials: true,
    packageAllowlist: ["com.example.allowed"]
  };

  it("allows package names in the allowlist", () => {
    expect(() => assertPackageAllowed("com.example.allowed", config)).not.toThrow();
  });

  it("rejects package names outside the allowlist before API calls", () => {
    expect(() => assertPackageAllowed("com.example.blocked", config)).toThrow(
      expect.objectContaining({ code: "PACKAGE_NOT_ALLOWED" })
    );
  });
});

describe("inspectPlaystoreConfig", () => {
  it("reports credential and allowlist status without secret values", () => {
    const status = inspectPlaystoreConfig({
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/not-a-real-secret-file.json",
      PLAYSTORE_PACKAGE_ALLOWLIST: "com.example.app",
      PLAYSTORE_DEFAULT_PACKAGE: "com.example.app"
    });

    expect(status.credentials.message).not.toContain("/tmp/not-a-real-secret-file.json");
    expect(status.packageAllowlist).toMatchObject({
      configured: true,
      packages: ["com.example.app"]
    });
    expect(status.defaultPackage.allowed).toBe(true);
  });
});

describe("createGoogleAuth", () => {
  it("creates an auth helper from valid local config without contacting Google APIs", () => {
    const auth = createGoogleAuth({
      useApplicationDefaultCredentials: true,
      packageAllowlist: ["com.example.app"]
    });

    expect(auth).toBeDefined();
  });

  it("does not include credential paths in missing credential errors", () => {
    expect(() =>
      createGoogleAuth({
        useApplicationDefaultCredentials: false,
        packageAllowlist: ["com.example.app"]
      })
    ).toThrow(expect.objectContaining({ code: "MISSING_CREDENTIALS" }));
  });

  it("wraps Google auth failures without leaking credential paths", async () => {
    const secretPath = "/tmp/playstore-secret-does-not-exist.json";

    await expect(
      createAuthenticatedClient({
        credentialsFile: secretPath,
        useApplicationDefaultCredentials: false,
        packageAllowlist: ["com.example.app"]
      })
    ).rejects.toMatchObject({
      code: "API_AUTH_FAILED",
      message: expect.not.stringContaining(secretPath),
      hint: expect.not.stringContaining(secretPath)
    });
  });
});
