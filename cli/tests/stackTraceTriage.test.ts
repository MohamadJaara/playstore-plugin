import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { runStacktraceTriage } from "../src/commands/triage.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stack trace source triage", () => {
  it("maps Kotlin class and method frames to local source files", async () => {
    const sourceRoot = await createSourceRoot({
      "app/src/main/java/com/example/MainActivity.kt": [
        "package com.example",
        "",
        "class MainActivity {",
        "  fun onCreate() {",
        "    crash()",
        "  }",
        "",
        "  fun crash() {",
        "    error(\"boom\")",
        "  }",
        "}"
      ].join("\n")
    });
    const output = await runStacktraceTriage({
      stackTrace: [
        "java.lang.IllegalStateException: boom",
        "    at com.example.MainActivity.onCreate(MainActivity.kt:4)"
      ].join("\n"),
      sourceRoot,
      maxFiles: 10,
      git: false,
      format: "json"
    });

    expect(output.summary).toMatchObject({
      confidence: "high",
      matchedFrameCount: 1,
      unmatchedFrameCount: 0
    });
    expect(output.suspectFiles[0]).toMatchObject({
      relativePath: "app/src/main/java/com/example/MainActivity.kt",
      confidence: "high"
    });
    expect(output.frames[0].candidates[0]).toMatchObject({
      relativePath: "app/src/main/java/com/example/MainActivity.kt",
      line: 4,
      match: "class-and-method",
      confidence: "high"
    });
  });

  it("maps Java frames and attaches optional git hints through the provider", async () => {
    const sourceRoot = await createSourceRoot({
      "app/src/main/java/com/example/Repository.java": [
        "package com.example;",
        "",
        "public class Repository {",
        "  public String load() {",
        "    return \"ok\";",
        "  }",
        "}"
      ].join("\n")
    });
    const output = await runStacktraceTriage(
      {
        stackTrace: ["java.lang.RuntimeException: failed", "    at com.example.Repository.load(Repository.java:4)"].join("\n"),
        sourceRoot,
        maxFiles: 10,
        git: true,
        format: "json"
      },
      {
        gitHintProvider: async () => ({
          lastCommit: {
            hash: "1234567890abcdef",
            authorName: "Example Dev",
            date: "2026-06-23T12:00:00Z",
            subject: "Touch repository"
          },
          blame: {
            hash: "abcdef1234567890",
            line: 4,
            authorName: "Example Dev",
            date: "2026-06-22T12:00:00Z",
            subject: "Add load method"
          }
        })
      }
    );

    expect(output.suspectFiles[0]).toMatchObject({
      relativePath: "app/src/main/java/com/example/Repository.java",
      git: {
        lastCommit: {
          hash: "1234567890abcdef",
          subject: "Touch repository"
        },
        blame: {
          hash: "abcdef1234567890",
          line: 4
        }
      }
    });
    expect(output.frames[0].candidates[0]).toMatchObject({
      match: "class-and-method",
      confidence: "high"
    });
  });

  it("caps confidence when the frame package disagrees with the local source package", async () => {
    const sourceRoot = await createSourceRoot({
      "app/src/main/java/com/good/MainActivity.kt": [
        "package com.good",
        "",
        "class MainActivity {",
        "  fun onCreate() {",
        "    error(\"boom\")",
        "  }",
        "}"
      ].join("\n")
    });
    const output = await runStacktraceTriage({
      stackTrace: [
        "java.lang.IllegalStateException: boom",
        "    at com.bad.MainActivity.onCreate(MainActivity.kt:4)"
      ].join("\n"),
      sourceRoot,
      maxFiles: 10,
      git: false,
      format: "json"
    });

    expect(output.summary.confidence).not.toBe("high");
    expect(output.summary.answer).toContain("medium confidence");
    expect(output.suspectFiles[0]).toMatchObject({
      relativePath: "app/src/main/java/com/good/MainActivity.kt",
      confidence: "medium"
    });
    expect(output.frames[0].candidates[0]).toMatchObject({
      relativePath: "app/src/main/java/com/good/MainActivity.kt",
      confidence: "medium"
    });
    expect(output.frames[0].candidates[0].match).not.toBe("class-and-method");
    expect(output.frames[0].candidates[0].reasons.join("\n")).toContain("does not match local package");
  });

  it("uses obfuscated source-file hints without claiming high confidence", async () => {
    const sourceRoot = await createSourceRoot({
      "app/src/main/java/com/example/MainActivity.kt": [
        "package com.example",
        "",
        "class MainActivity {",
        "  fun onCreate() {",
        "    error(\"boom\")",
        "  }",
        "}"
      ].join("\n")
    });
    const output = await runStacktraceTriage({
      stackTrace: ["java.lang.RuntimeException", "    at a.b.c.a(MainActivity.kt:4)", "    at a.b.d.b(Unknown Source:12)"].join(
        "\n"
      ),
      sourceRoot,
      maxFiles: 10,
      git: false,
      format: "json"
    });

    expect(output.summary.obfuscatedFrameCount).toBe(2);
    expect(output.summary.confidence).not.toBe("high");
    expect(output.frames[0]).toMatchObject({
      obfuscated: true,
      candidates: [
        expect.objectContaining({
          relativePath: "app/src/main/java/com/example/MainActivity.kt",
          match: "obfuscated-file-hint",
          confidence: "low"
        })
      ]
    });
    expect(output.frames[1].candidates).toEqual([]);
    expect(output.warnings.join("\n")).toContain("look obfuscated");
  });

  it("links partially missing frames when class and method names still match", async () => {
    const sourceRoot = await createSourceRoot({
      "app/src/main/java/com/example/Legacy.java": [
        "package com.example;",
        "",
        "public class Legacy {",
        "  public void run() {",
        "    throw new IllegalStateException();",
        "  }",
        "}"
      ].join("\n")
    });
    const output = await runStacktraceTriage({
      stackTrace: [
        "java.lang.IllegalStateException",
        "    at com.example.Legacy.run(Unknown Source)",
        "    at com.example.Missing.nope(Missing.kt:22)"
      ].join("\n"),
      sourceRoot,
      maxFiles: 10,
      git: false,
      format: "json"
    });

    expect(output.summary).toMatchObject({
      matchedFrameCount: 1,
      unmatchedFrameCount: 1
    });
    expect(output.frames[0].candidates[0]).toMatchObject({
      relativePath: "app/src/main/java/com/example/Legacy.java",
      line: 4,
      match: "class-and-method",
      confidence: "high"
    });
    expect(output.frames[1].candidates).toEqual([]);
    expect(output.warnings.join("\n")).toContain("could not be linked");
  });
});

async function createSourceRoot(files: Record<string, string>): Promise<string> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "playstore-triage-"));
  tempRoots.push(sourceRoot);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const absolutePath = join(sourceRoot, relativePath);

      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    })
  );

  return sourceRoot;
}
