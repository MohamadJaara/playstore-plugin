import { readFile } from "node:fs/promises";

import { Command } from "commander";

import { triageStackTrace, type GitHintProvider } from "../domain/stackTraceTriage.js";
import { triageStacktraceInputSchema, type TriageStacktraceInput } from "../schemas/cliInputs.js";
import type { StackTraceTriageFrame, StackTraceTriageSuspectFile, TriageStacktraceOutput } from "../schemas/cliOutputs.js";
import { parsePositiveInteger } from "../utils/dateRanges.js";
import { PlaystoreCliError } from "../utils/errors.js";
import { escapeMarkdownTableCell } from "../utils/markdown.js";
import { printJson, printMarkdown } from "../utils/output.js";

interface TriageStacktraceOptions {
  file?: string;
  stacktrace?: string;
  sourceRoot: string;
  maxFiles: number;
  git: boolean;
  format: string;
}

export function createTriageCommand(): Command {
  const command = new Command("triage");

  command.description("Connect Play crash data and stack traces to the local source tree.");
  command.addCommand(createTriageStacktraceCommand());

  return command;
}

export function createTriageStacktraceCommand(): Command {
  const command = new Command("stacktrace");

  command
    .description("Map a JVM stack trace to likely local Kotlin and Java source files.")
    .option("--file <path>", "Read stack trace text from a file.")
    .option("--stacktrace <text>", "Inline stack trace text. For multiline traces, prefer --file or stdin.")
    .option("--source-root <path>", "Local source tree root to search.", ".")
    .option("--max-files <maxFiles>", "Maximum suspect files to return.", parsePositiveInteger, 10)
    .option("--git", "Include local git blame and recent commit hints.", false)
    .option("--format <format>", "Output format: json or markdown.", "json")
    .action(async (options: TriageStacktraceOptions) => {
      const stackTrace = await resolveStackTraceInput(options);
      const input = triageStacktraceInputSchema.parse({
        stackTrace,
        sourceRoot: options.sourceRoot,
        maxFiles: options.maxFiles,
        git: options.git,
        format: options.format
      });
      const output = await runStacktraceTriage(input);

      if (input.format === "markdown") {
        printMarkdown(formatStacktraceTriageMarkdown(output));
      } else {
        printJson(output);
      }
    });

  return command;
}

export async function runStacktraceTriage(
  input: TriageStacktraceInput,
  dependencies: {
    gitHintProvider?: GitHintProvider;
  } = {}
): Promise<TriageStacktraceOutput> {
  return triageStackTrace(input.stackTrace, {
    sourceRoot: input.sourceRoot,
    maxFiles: input.maxFiles,
    includeGitHints: input.git,
    gitHintProvider: dependencies.gitHintProvider
  });
}

async function resolveStackTraceInput(options: Pick<TriageStacktraceOptions, "file" | "stacktrace">): Promise<string> {
  if (options.file && options.stacktrace) {
    throw new PlaystoreCliError(
      "INVALID_CONFIG",
      "Stack trace input is ambiguous.",
      "Pass either --file, --stacktrace, or pipe stack trace text on stdin."
    );
  }

  if (options.file) {
    return readFile(options.file, "utf8");
  }

  if (options.stacktrace) {
    return options.stacktrace;
  }

  if (process.stdin.isTTY) {
    throw new PlaystoreCliError(
      "INVALID_CONFIG",
      "No stack trace text was provided.",
      "Pass --file, --stacktrace, or pipe stack trace text into scripts/playstore triage stacktrace."
    );
  }

  return readStdin();
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => {
      resolve(text);
    });
    process.stdin.on("error", reject);
  });
}

function formatStacktraceTriageMarkdown(output: TriageStacktraceOutput): string {
  return [
    "# Stack Trace Triage",
    "",
    output.summary.answer,
    "",
    `Source root: ${output.sourceRoot}`,
    formatException(output),
    "",
    "## Suspect Files",
    "",
    formatSuspectFilesTable(output.suspectFiles),
    "",
    "## Frame Matches",
    "",
    output.frames.map(formatFrameSection).join("\n\n") || "_No parseable stack frames._",
    output.warnings.length > 0 ? ["", "## Warnings", "", ...output.warnings.map((warning) => `- ${warning}`)].join("\n") : "",
    output.summary.nextActions.length > 0
      ? ["", "## Next Actions", "", ...output.summary.nextActions.map((action) => `- ${action}`)].join("\n")
      : ""
  ]
    .filter((section) => section !== "")
    .join("\n");
}

function formatException(output: TriageStacktraceOutput): string {
  if (output.stackTrace.exceptionType) {
    return `Exception: ${output.stackTrace.exceptionType}${output.stackTrace.exceptionMessage ? `: ${output.stackTrace.exceptionMessage}` : ""}`;
  }

  if (output.stackTrace.signal) {
    return `Signal: ${output.stackTrace.signal}`;
  }

  return "Exception: _unknown_";
}

function formatSuspectFilesTable(suspectFiles: StackTraceTriageSuspectFile[]): string {
  const rows = suspectFiles.map((file) =>
    [
      file.relativePath,
      file.confidence,
      String(file.score),
      String(file.frameMatches.length),
      file.git?.lastCommit ? shortHash(file.git.lastCommit.hash) : "_not included_",
      file.frameMatches
        .map((match) => (match.line ? `frame ${match.frameIndex}:${match.line}` : `frame ${match.frameIndex}`))
        .join(", ")
    ]
      .map(escapeMarkdownTableCell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |")
  );

  return [
    "| File | Confidence | Score | Frames | Last commit | Links |",
    "| --- | --- | ---: | ---: | --- | --- |",
    ...rows
  ].join("\n");
}

function formatFrameSection(frame: StackTraceTriageFrame): string {
  const candidates = frame.candidates.length === 0 ? "_No local source candidates._" : frame.candidates.map(formatCandidate).join("\n");
  const obfuscated = frame.obfuscated ? " yes" : " no";

  return [`### Frame ${frame.index}`, "", `\`${frame.raw}\``, `Obfuscated:${obfuscated}`, "", candidates].join("\n");
}

function formatCandidate(candidate: StackTraceTriageFrame["candidates"][number]): string {
  const line = candidate.line ? `:${candidate.line}` : "";
  const reasons = candidate.reasons.join(" ");

  return `- ${candidate.relativePath}${line} (${candidate.confidence}, ${candidate.match}, score ${candidate.score})${reasons ? ` - ${reasons}` : ""}`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
