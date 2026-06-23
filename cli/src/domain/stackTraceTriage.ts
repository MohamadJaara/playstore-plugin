import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { extractStackTrace } from "./stackTraceParser.js";
import {
  triageStacktraceOutputSchema,
  type StackTraceFrame,
  type StackTraceTriageBlameHint,
  type StackTraceTriageCommitHint,
  type StackTraceTriageConfidence,
  type StackTraceTriageFrame,
  type StackTraceTriageFrameCandidate,
  type StackTraceTriageMatch,
  type StackTraceTriageSuspectFile,
  type TriageStacktraceOutput
} from "../schemas/cliOutputs.js";

const execFileAsync = promisify(execFile);

const SOURCE_EXTENSIONS = new Set([".java", ".kt"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".kotlin",
  ".mvn",
  ".settings",
  "build",
  "dist",
  "node_modules",
  "out",
  "target"
]);
const MAX_FRAME_CANDIDATES = 3;

export interface StackTraceTriageOptions {
  sourceRoot: string;
  maxFiles: number;
  includeGitHints?: boolean;
  gitHintProvider?: GitHintProvider;
}

export type GitHintProvider = (
  sourceRoot: string,
  file: { path: string; relativePath: string; line?: number }
) => Promise<StackTraceTriageSuspectFile["git"] | undefined>;

interface SourceIndex {
  files: SourceFile[];
  byFileName: Map<string, Set<SourceFile>>;
  byQualifiedClassName: Map<string, Set<SourceFile>>;
  bySimpleClassName: Map<string, Set<SourceFile>>;
  byMethodName: Map<string, Set<SourceFile>>;
}

interface SourceFile {
  path: string;
  relativePath: string;
  fileName: string;
  extension: string;
  packageName?: string;
  classes: SourceClass[];
  syntheticClasses: SourceClass[];
  methods: SourceMethod[];
  lineCount: number;
}

interface SourceClass {
  name: string;
  qualifiedName: string;
  line: number;
  synthetic?: boolean;
}

interface SourceMethod {
  name: string;
  line: number;
}

interface ClassMatch {
  score: number;
  line: number;
  reason: string;
  qualified: boolean;
}

interface MethodMatch {
  line: number;
  reason: string;
}

interface ScoredFrameCandidate extends StackTraceTriageFrameCandidate {
  frameIndex: number;
  rawFrame: string;
}

interface SuspectFilesResult {
  suspectFiles: StackTraceTriageSuspectFile[];
  truncated: boolean;
}

export async function triageStackTrace(
  stackTraceText: string,
  options: StackTraceTriageOptions
): Promise<TriageStacktraceOutput> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const index = await buildSourceIndex(sourceRoot);
  const stackTrace = extractStackTrace(stackTraceText);
  const frames = stackTrace.frames.map((frame, frameIndex) => {
    const candidates = scoreFrame(frameIndex, frame, index);

    return {
      ...frame,
      index: frameIndex,
      obfuscated: isObfuscatedFrame(frame),
      candidates: candidates.slice(0, MAX_FRAME_CANDIDATES)
    };
  });
  const suspectFilesResult = await buildSuspectFiles(frames, sourceRoot, options);
  const warnings = buildWarnings(stackTrace, frames, suspectFilesResult.suspectFiles, index.files.length, suspectFilesResult.truncated);
  const summary = buildSummary(frames, suspectFilesResult.suspectFiles, Boolean(options.includeGitHints));

  return triageStacktraceOutputSchema.parse({
    sourceRoot,
    stackTrace,
    frames,
    suspectFiles: suspectFilesResult.suspectFiles,
    summary,
    warnings
  });
}

async function buildSourceIndex(sourceRoot: string): Promise<SourceIndex> {
  const sourceRootStat = await stat(sourceRoot);

  if (!sourceRootStat.isDirectory()) {
    throw new Error(`Source root is not a directory: ${sourceRoot}`);
  }

  const sourcePaths = await listSourcePaths(sourceRoot);
  const files = await Promise.all(sourcePaths.map((sourcePath) => readSourceMetadata(sourceRoot, sourcePath)));
  const byFileName = new Map<string, Set<SourceFile>>();
  const byQualifiedClassName = new Map<string, Set<SourceFile>>();
  const bySimpleClassName = new Map<string, Set<SourceFile>>();
  const byMethodName = new Map<string, Set<SourceFile>>();

  for (const file of files) {
    addToIndex(byFileName, file.fileName, file);

    for (const sourceClass of [...file.classes, ...file.syntheticClasses]) {
      addToIndex(byQualifiedClassName, sourceClass.qualifiedName, file);
      addToIndex(bySimpleClassName, sourceClass.name, file);
    }

    for (const method of file.methods) {
      addToIndex(byMethodName, method.name, file);
    }
  }

  return {
    files,
    byFileName,
    byQualifiedClassName,
    bySimpleClassName,
    byMethodName
  };
}

async function listSourcePaths(sourceRoot: string): Promise<string[]> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const sourcePaths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(sourceRoot, entry.name);

      if (entry.isSymbolicLink()) {
        return [];
      }

      if (entry.isDirectory()) {
        return IGNORED_DIRECTORIES.has(entry.name) ? [] : listSourcePaths(entryPath);
      }

      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        return [entryPath];
      }

      return [];
    })
  );

  return sourcePaths.flat();
}

async function readSourceMetadata(sourceRoot: string, sourcePath: string): Promise<SourceFile> {
  const content = await readFile(sourcePath, "utf8");
  const extension = path.extname(sourcePath);
  const relativePath = toPosixPath(path.relative(sourceRoot, sourcePath));
  const fileName = path.basename(sourcePath);
  const lines = content.split(/\r?\n/);
  const packageName = extractPackageName(lines);
  const classes = extractClasses(lines, packageName);
  const syntheticClasses = extension === ".kt" ? syntheticKotlinClasses(fileName, packageName, lines, classes) : [];
  const methods = extractMethods(lines, classes);

  return {
    path: sourcePath,
    relativePath,
    fileName,
    extension,
    packageName,
    classes,
    syntheticClasses,
    methods,
    lineCount: lines.length
  };
}

function extractPackageName(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = /^\s*package\s+([A-Za-z_][\w.]*)\s*;?\s*$/.exec(line);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function extractClasses(lines: string[], packageName: string | undefined): SourceClass[] {
  const classes: SourceClass[] = [];

  lines.forEach((line, lineIndex) => {
    const classPattern =
      /\b(?:enum\s+class|annotation\s+class|data\s+class|sealed\s+class|class|interface|object|enum)\s+([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;

    while ((match = classPattern.exec(line))) {
      const name = match[1];

      classes.push({
        name,
        qualifiedName: qualifyName(packageName, name),
        line: lineIndex + 1
      });
    }
  });

  return classes;
}

function syntheticKotlinClasses(
  fileName: string,
  packageName: string | undefined,
  lines: string[],
  classes: SourceClass[]
): SourceClass[] {
  const baseName = path.basename(fileName, ".kt");

  if (!baseName) {
    return [];
  }

  const firstMethodLine = lines.findIndex((line) => /^\s*(?:[\w]+\s+)*fun\s+/.test(line));

  return [
    {
      name: `${baseName}Kt`,
      qualifiedName: qualifyName(packageName, `${baseName}Kt`),
      line: firstMethodLine >= 0 ? firstMethodLine + 1 : classes[0]?.line ?? 1,
      synthetic: true
    }
  ];
}

function extractMethods(lines: string[], classes: SourceClass[]): SourceMethod[] {
  const methods: SourceMethod[] = [];

  lines.forEach((line, lineIndex) => {
    const methodName = parseMethodName(line, classes.map((sourceClass) => sourceClass.name));

    if (methodName) {
      methods.push({
        name: methodName,
        line: lineIndex + 1
      });
    }
  });

  return methods;
}

function parseMethodName(line: string, classNames: string[]): string | undefined {
  const trimmed = line.trim();

  if (!trimmed || /^\*/.test(trimmed) || /\b(?:if|for|while|switch|catch)\s*\(/.test(trimmed)) {
    return undefined;
  }

  const kotlinMatch =
    /^\s*(?:(?:public|private|protected|internal|suspend|inline|operator|override|tailrec|external|infix|actual|expect|final|open|abstract)\s+)*fun\s+(?:<[^>]+>\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(
      line
    );

  if (kotlinMatch) {
    return kotlinMatch[1];
  }

  if (/\b(?:class|interface|object|enum)\b/.test(line)) {
    return undefined;
  }

  for (const className of classNames) {
    const constructorPattern = new RegExp(
      `^\\s*(?:(?:public|private|protected)\\s+)?${escapeRegExp(className)}\\s*\\(`
    );

    if (constructorPattern.test(line)) {
      return "<init>";
    }
  }

  const javaMatch =
    /^\s*(?:(?:public|private|protected|static|final|synchronized|native|abstract|strictfp|default)\s+)*(?:<[^>]+>\s*)?(?:[A-Za-z_$][\w$<>\[\].?,]*\s+)+([A-Za-z_$][\w$]*)\s*\(/.exec(
      line
    );

  return javaMatch?.[1];
}

function scoreFrame(frameIndex: number, frame: StackTraceFrame, sourceIndex: SourceIndex): ScoredFrameCandidate[] {
  const candidateFiles = candidateFilesForFrame(frame, sourceIndex);
  const candidates = [...candidateFiles]
    .map((file) => scoreFrameFile(frameIndex, frame, file))
    .filter((candidate): candidate is ScoredFrameCandidate => candidate !== undefined)
    .sort(compareCandidates);

  return candidates;
}

function candidateFilesForFrame(frame: StackTraceFrame, sourceIndex: SourceIndex): Set<SourceFile> {
  const candidates = new Set<SourceFile>();
  const obfuscated = isObfuscatedFrame(frame);
  const frameFile = frame.file;

  if (meaningfulFrameFile(frameFile)) {
    addIndexedFiles(candidates, sourceIndex.byFileName, path.basename(frameFile));
  }

  for (const qualifiedName of qualifiedClassCandidates(frame.declaringClass)) {
    addIndexedFiles(candidates, sourceIndex.byQualifiedClassName, qualifiedName);
  }

  for (const simpleName of simpleClassCandidates(frame.declaringClass)) {
    addIndexedFiles(candidates, sourceIndex.bySimpleClassName, simpleName);
  }

  if (!obfuscated && isUsefulMethodName(frame.method)) {
    addIndexedFiles(candidates, sourceIndex.byMethodName, frame.method);
  }

  return candidates;
}

function scoreFrameFile(frameIndex: number, frame: StackTraceFrame, file: SourceFile): ScoredFrameCandidate | undefined {
  const reasons: string[] = [];
  const obfuscated = isObfuscatedFrame(frame);
  const classMatch = classMatchForFrame(frame, file);
  const methodMatch = methodMatchForFrame(frame, file, classMatch);
  const fileNameMatches = Boolean(meaningfulFrameFile(frame.file) && lower(path.basename(frame.file)) === lower(file.fileName));
  const framePackage = frame.declaringClass ? declaringPackage(frame.declaringClass) : undefined;
  const packageMatches = Boolean(framePackage && file.packageName && framePackage === file.packageName);
  const packageMismatch = Boolean(framePackage && file.packageName && framePackage !== file.packageName);
  const sourceLine = sourceLineForFrame(frame, file, methodMatch, classMatch);
  let score = 0;

  if (classMatch) {
    score += classMatch.score;
    reasons.push(classMatch.reason);
  }

  if (fileNameMatches) {
    score += obfuscated ? 34 : 30;
    reasons.push(`Stack frame source file matches ${file.fileName}.`);
  }

  if (methodMatch) {
    score += 25;
    reasons.push(methodMatch.reason);
  }

  if (frame.line && frame.line <= file.lineCount && (classMatch || fileNameMatches || methodMatch)) {
    score += 10;
    reasons.push(`Stack frame line ${frame.line} is inside the local file.`);
  }

  if (packageMatches && classMatch) {
    score += 5;
    reasons.push(`Local package ${file.packageName} matches the frame package.`);
  }

  if (packageMismatch) {
    score = Math.min(score, 59);
    reasons.push(`Frame package ${framePackage} does not match local package ${file.packageName}; confidence is capped.`);
  }

  if (score === 0) {
    return undefined;
  }

  if (obfuscated) {
    score = Math.min(score, fileNameMatches ? 59 : 39);
    reasons.push("Frame appears obfuscated; confidence is capped until a mapping file is applied.");
  }

  const match = matchKind(classMatch, methodMatch, fileNameMatches, obfuscated, packageMismatch);
  const confidence = confidenceForScore(score, obfuscated, fileNameMatches);

  return {
    path: file.path,
    relativePath: file.relativePath,
    line: sourceLine,
    match,
    confidence,
    score: roundScore(score),
    reasons: unique(reasons),
    frameIndex,
    rawFrame: frame.raw
  };
}

function classMatchForFrame(frame: StackTraceFrame, file: SourceFile): ClassMatch | undefined {
  if (!frame.declaringClass) {
    return undefined;
  }

  const qualifiedCandidates = new Set(qualifiedClassCandidates(frame.declaringClass).map(normalizeLookupKey));
  const simpleCandidates = new Set(simpleClassCandidates(frame.declaringClass).map(normalizeLookupKey));

  for (const sourceClass of file.classes) {
    if (qualifiedCandidates.has(normalizeLookupKey(sourceClass.qualifiedName))) {
      return {
        score: 55,
        line: sourceClass.line,
        reason: `Declaring class matches ${sourceClass.qualifiedName}.`,
        qualified: true
      };
    }
  }

  for (const sourceClass of file.syntheticClasses) {
    if (qualifiedCandidates.has(normalizeLookupKey(sourceClass.qualifiedName))) {
      return {
        score: 55,
        line: sourceClass.line,
        reason: `Kotlin top-level class matches ${sourceClass.qualifiedName}.`,
        qualified: true
      };
    }
  }

  for (const sourceClass of file.classes) {
    if (simpleCandidates.has(normalizeLookupKey(sourceClass.name))) {
      return {
        score: 38,
        line: sourceClass.line,
        reason: `Simple class name matches ${sourceClass.name}.`,
        qualified: false
      };
    }
  }

  return undefined;
}

function methodMatchForFrame(
  frame: StackTraceFrame,
  file: SourceFile,
  classMatch: ClassMatch | undefined
): MethodMatch | undefined {
  if (!frame.method) {
    return undefined;
  }

  if (frame.method === "<init>" || frame.method === "<clinit>") {
    return classMatch
      ? {
          line: classMatch.line,
          reason: `Constructor or class initializer maps to the matched class declaration.`
        }
      : undefined;
  }

  const method = file.methods.find((entry) => entry.name === frame.method);

  if (!method) {
    return undefined;
  }

  return {
    line: method.line,
    reason: `Method ${frame.method} exists in the local file.`
  };
}

function sourceLineForFrame(
  frame: StackTraceFrame,
  file: SourceFile,
  methodMatch: MethodMatch | undefined,
  classMatch: ClassMatch | undefined
): number | undefined {
  if (frame.line && frame.line <= file.lineCount) {
    return frame.line;
  }

  return methodMatch?.line ?? classMatch?.line;
}

async function buildSuspectFiles(
  frames: StackTraceTriageFrame[],
  sourceRoot: string,
  options: StackTraceTriageOptions
): Promise<SuspectFilesResult> {
  const byPath = new Map<string, StackTraceTriageSuspectFile>();

  for (const frame of frames) {
    for (const candidate of frame.candidates) {
      const existing =
        byPath.get(candidate.path) ??
        ({
          path: candidate.path,
          relativePath: candidate.relativePath,
          score: 0,
          confidence: "low",
          reasons: [],
          frameMatches: []
        } satisfies StackTraceTriageSuspectFile);
      const framePositionBoost = Math.max(0, 12 - frame.index * 2);

      existing.score = roundScore(existing.score + candidate.score + framePositionBoost);
      existing.confidence = maxConfidence(existing.confidence, candidate.confidence);
      existing.reasons = unique([...existing.reasons, ...candidate.reasons]);
      existing.frameMatches.push({
        frameIndex: frame.index,
        rawFrame: frame.raw,
        line: candidate.line,
        match: candidate.match,
        confidence: candidate.confidence,
        reasons: candidate.reasons
      });
      byPath.set(candidate.path, existing);
    }
  }

  const sortedSuspects = [...byPath.values()].sort(
    (left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath)
  );
  const suspects = sortedSuspects.slice(0, options.maxFiles);

  if (options.includeGitHints) {
    const provider = options.gitHintProvider ?? defaultGitHintProvider;

    for (const suspect of suspects) {
      const line = suspect.frameMatches.find((match) => match.line)?.line;
      const git = await provider(sourceRoot, {
        path: suspect.path,
        relativePath: suspect.relativePath,
        line
      });

      if (git?.lastCommit || git?.blame) {
        suspect.git = git;
      }
    }
  }

  return {
    suspectFiles: suspects,
    truncated: sortedSuspects.length > suspects.length
  };
}

async function defaultGitHintProvider(
  sourceRoot: string,
  file: { relativePath: string; line?: number }
): Promise<StackTraceTriageSuspectFile["git"] | undefined> {
  const [lastCommit, blame] = await Promise.all([
    gitLastCommit(sourceRoot, file.relativePath),
    file.line ? gitBlameLine(sourceRoot, file.relativePath, file.line) : Promise.resolve(undefined)
  ]);

  return lastCommit || blame
    ? {
        lastCommit,
        blame
      }
    : undefined;
}

async function gitLastCommit(sourceRoot: string, relativePath: string): Promise<StackTraceTriageCommitHint | undefined> {
  const stdout = await safeGit(sourceRoot, ["log", "-1", "--format=%H%x1f%an%x1f%aI%x1f%s", "--", relativePath]);
  const [hash, authorName, date, subject] = stdout.trim().split("\u001f");

  return hash
    ? {
        hash,
        authorName: authorName || undefined,
        date: date || undefined,
        subject: subject || undefined
      }
    : undefined;
}

async function gitBlameLine(
  sourceRoot: string,
  relativePath: string,
  line: number
): Promise<StackTraceTriageBlameHint | undefined> {
  const stdout = await safeGit(sourceRoot, ["blame", "-L", `${line},${line}`, "--line-porcelain", "--", relativePath]);
  const lines = stdout.split(/\r?\n/);
  const hash = lines[0]?.split(/\s+/)[0];
  const authorName = parsePorcelainValue(lines, "author");
  const authorTime = parsePorcelainValue(lines, "author-time");
  const subject = parsePorcelainValue(lines, "summary");

  return hash && hash !== "0000000000000000000000000000000000000000"
    ? {
        hash,
        line,
        authorName,
        date: authorTime ? new Date(Number(authorTime) * 1000).toISOString() : undefined,
        subject
      }
    : undefined;
}

async function safeGit(sourceRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: sourceRoot,
      maxBuffer: 1024 * 1024
    });

    return stdout;
  } catch {
    return "";
  }
}

function parsePorcelainValue(lines: string[], key: string): string | undefined {
  const prefix = `${key} `;
  const line = lines.find((entry) => entry.startsWith(prefix));

  return line?.slice(prefix.length) || undefined;
}

function buildWarnings(
  stackTrace: TriageStacktraceOutput["stackTrace"],
  frames: StackTraceTriageFrame[],
  suspectFiles: StackTraceTriageSuspectFile[],
  indexedFileCount: number,
  suspectFilesTruncated: boolean
): string[] {
  const warnings: string[] = [];
  const obfuscatedCount = frames.filter((frame) => frame.obfuscated).length;
  const unmatchedCount = frames.filter((frame) => frame.candidates.length === 0).length;
  const nativeCount = stackTrace.frames.filter((frame) => frame.native).length;

  if (indexedFileCount === 0) {
    warnings.push("No Kotlin or Java source files were found under the source root.");
  }

  if (stackTrace.frames.length === 0) {
    warnings.push("No parseable JVM stack frames were found in the provided text.");
  }

  if (stackTrace.malformedLines.length > 0) {
    warnings.push(`${stackTrace.malformedLines.length} malformed stack trace line(s) were skipped.`);
  }

  if (obfuscatedCount > 0) {
    warnings.push(
      `${obfuscatedCount} frame(s) look obfuscated; matches are low or medium confidence until the trace is deobfuscated.`
    );
  }

  if (unmatchedCount > 0) {
    warnings.push(`${unmatchedCount} frame(s) could not be linked to local Kotlin or Java source files.`);
  }

  if (nativeCount > 0) {
    warnings.push(`${nativeCount} native frame(s) were parsed but local Kotlin/Java source matching may not apply.`);
  }

  if (suspectFilesTruncated) {
    warnings.push(`Suspect files were limited to the top ${suspectFiles.length} result(s).`);
  }

  return unique(warnings);
}

function buildSummary(
  frames: StackTraceTriageFrame[],
  suspectFiles: StackTraceTriageSuspectFile[],
  includeGitHints: boolean
): TriageStacktraceOutput["summary"] {
  const matchedFrameCount = frames.filter((frame) => frame.candidates.length > 0).length;
  const unmatchedFrameCount = frames.length - matchedFrameCount;
  const obfuscatedFrameCount = frames.filter((frame) => frame.obfuscated).length;
  const topSuspect = suspectFiles[0];
  const confidence = topSuspect?.confidence ?? "low";
  const answer = topSuspect
    ? `Top suspect: ${topSuspect.relativePath}${firstLineSuffix(topSuspect)} (${confidence} confidence, ${matchedFrameCount}/${frames.length} frame(s) linked).`
    : frames.length === 0
      ? "No parseable stack frames were found."
      : obfuscatedFrameCount > 0
        ? "No confident local source match was found; deobfuscate the stack trace before assigning ownership."
        : "No local Kotlin or Java source file could be linked to the parsed stack frames.";

  return {
    answer,
    confidence,
    matchedFrameCount,
    unmatchedFrameCount,
    obfuscatedFrameCount,
    suspectFileCount: suspectFiles.length,
    nextActions: nextActions(frames, suspectFiles, includeGitHints)
  };
}

function nextActions(
  frames: StackTraceTriageFrame[],
  suspectFiles: StackTraceTriageSuspectFile[],
  includeGitHints: boolean
): string[] {
  const actions: string[] = [];
  const obfuscatedCount = frames.filter((frame) => frame.obfuscated).length;
  const topSuspect = suspectFiles[0];

  if (topSuspect) {
    actions.push(`Inspect ${topSuspect.relativePath}${firstLineSuffix(topSuspect)} for the top linked frame.`);
    actions.push("Compare the suspected code path against recent release changes and crash reproduction notes.");
  } else if (frames.length > 0) {
    actions.push("Confirm --source-root points at the Android application source tree.");
  }

  if (obfuscatedCount > 0) {
    actions.push("Apply the matching R8/ProGuard mapping file and rerun triage on the deobfuscated trace.");
  }

  if (suspectFiles.length > 0 && !includeGitHints) {
    actions.push("Rerun with --git to include local blame and recent commit hints.");
  } else if (suspectFiles.length > 0 && includeGitHints && !suspectFiles.some((file) => file.git)) {
    actions.push("No local git hints were available; confirm the source root is inside the relevant git worktree.");
  }

  return unique(actions);
}

function firstLineSuffix(suspect: StackTraceTriageSuspectFile): string {
  const line = suspect.frameMatches.find((match) => match.line)?.line;

  return line ? `:${line}` : "";
}

function matchKind(
  classMatch: ClassMatch | undefined,
  methodMatch: MethodMatch | undefined,
  fileNameMatches: boolean,
  obfuscated: boolean,
  packageMismatch: boolean
): StackTraceTriageMatch {
  if (obfuscated && fileNameMatches) {
    return "obfuscated-file-hint";
  }

  if (classMatch?.qualified && methodMatch && !packageMismatch) {
    return "class-and-method";
  }

  if (classMatch) {
    return "class";
  }

  if (fileNameMatches && methodMatch) {
    return "file-and-method";
  }

  if (fileNameMatches) {
    return "file";
  }

  return "method";
}

function confidenceForScore(score: number, obfuscated: boolean, fileNameMatches: boolean): StackTraceTriageConfidence {
  const confidence: StackTraceTriageConfidence = score >= 80 ? "high" : score >= 50 ? "medium" : "low";

  if (!obfuscated) {
    return confidence;
  }

  return fileNameMatches && confidence === "high" ? "medium" : confidence === "medium" && !fileNameMatches ? "low" : confidence;
}

function maxConfidence(left: StackTraceTriageConfidence, right: StackTraceTriageConfidence): StackTraceTriageConfidence {
  const rank: Record<StackTraceTriageConfidence, number> = {
    low: 0,
    medium: 1,
    high: 2
  };

  return rank[right] > rank[left] ? right : left;
}

function compareCandidates(left: StackTraceTriageFrameCandidate, right: StackTraceTriageFrameCandidate): number {
  return right.score - left.score || left.relativePath.localeCompare(right.relativePath);
}

function qualifiedClassCandidates(declaringClass: string | undefined): string[] {
  if (!declaringClass) {
    return [];
  }

  const normalized = declaringClass.replace(/\$/g, ".");
  const topLevelQualifiedName = declaringClass.includes("$") ? declaringClass.slice(0, declaringClass.indexOf("$")) : undefined;
  const candidates = [declaringClass, normalized, topLevelQualifiedName].filter((candidate): candidate is string =>
    Boolean(candidate)
  );
  const packageName = declaringPackage(declaringClass);
  const simpleName = declaringSimpleName(declaringClass);
  const outerSimpleName = simpleName?.split("$").find((part) => part && !/^\d+$/.test(part));

  if (packageName && outerSimpleName) {
    candidates.push(`${packageName}.${outerSimpleName}`);
  }

  return unique(candidates.filter(Boolean));
}

function simpleClassCandidates(declaringClass: string | undefined): string[] {
  const simpleName = declaringSimpleName(declaringClass);

  if (!simpleName) {
    return [];
  }

  return unique([simpleName, ...simpleName.split("$").filter((part) => part && !/^\d+$/.test(part))]);
}

function declaringPackage(declaringClass: string): string | undefined {
  const topLevelQualifiedName = declaringClass.includes("$") ? declaringClass.slice(0, declaringClass.indexOf("$")) : declaringClass;
  const separator = topLevelQualifiedName.lastIndexOf(".");

  return separator === -1 ? undefined : topLevelQualifiedName.slice(0, separator);
}

function declaringSimpleName(declaringClass: string | undefined): string | undefined {
  if (!declaringClass) {
    return undefined;
  }

  const separator = declaringClass.lastIndexOf(".");

  return separator === -1 ? declaringClass : declaringClass.slice(separator + 1);
}

function isUsefulMethodName(method: string | undefined): method is string {
  return Boolean(method && method !== "<init>" && method !== "<clinit>");
}

function meaningfulFrameFile(file: string | undefined): file is string {
  return Boolean(file && file !== "Native Method" && file !== "Unknown Source" && file !== "SourceFile");
}

function isObfuscatedFrame(frame: StackTraceFrame): boolean {
  if (!frame.declaringClass) {
    return false;
  }

  const classSegments = frame.declaringClass.split(/[.$]/).filter(Boolean);
  const shortClassSegments = classSegments.filter((segment) => segment.length <= 2).length;
  const classLooksObfuscated = classSegments.length >= 2 && shortClassSegments / classSegments.length >= 0.6;
  const methodLooksObfuscated = Boolean(frame.method && frame.method.length <= 2 && !["go", "id", "io", "of", "on", "to"].includes(frame.method));
  const sourceLooksObfuscated = !meaningfulFrameFile(frame.file) || frame.file === "SourceFile" || Boolean(frame.unknownSource);

  return classLooksObfuscated && (methodLooksObfuscated || sourceLooksObfuscated);
}

function addIndexedFiles(target: Set<SourceFile>, index: Map<string, Set<SourceFile>>, key: string | undefined): void {
  if (!key) {
    return;
  }

  for (const file of index.get(normalizeLookupKey(key)) ?? []) {
    target.add(file);
  }
}

function addToIndex(index: Map<string, Set<SourceFile>>, key: string, file: SourceFile): void {
  const normalizedKey = normalizeLookupKey(key);
  const files = index.get(normalizedKey) ?? new Set<SourceFile>();

  files.add(file);
  index.set(normalizedKey, files);
}

function qualifyName(packageName: string | undefined, name: string): string {
  return packageName ? `${packageName}.${name}` : name;
}

function normalizeLookupKey(value: string): string {
  return lower(value.replace(/\$/g, "."));
}

function lower(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function unique<TValue>(values: TValue[]): TValue[] {
  return [...new Set(values)];
}

function roundScore(score: number): number {
  return Math.round(score * 10) / 10;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
