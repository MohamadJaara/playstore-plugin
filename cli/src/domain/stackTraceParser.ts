import { stackTraceExtractionSchema, type StackTraceExtraction, type StackTraceFrame } from "../schemas/cliOutputs.js";

const JAVA_FRAME_PATTERN = /^\s*at\s+(.+?)\((.*?)\)\s*$/;
const NATIVE_FRAME_PATTERN = /^\s*#\d+\s+pc\s+[0-9a-fA-F]+\s+(.+?)\s*$/;
const THREAD_PATTERN = /^\s*"([^"]+)"/;
const CAUSED_BY_PATTERN = /^\s*Caused by:\s+(.+?)(?::\s*(.*))?\s*$/;
const EXCEPTION_PATTERN = /^\s*((?:[\w$]+\.)+[\w$]*(?:Exception|Error|Throwable|Abort|Violation|Signal)[\w$]*)(?::\s*(.*))?\s*$/;
const FATAL_SIGNAL_PATTERN = /^\s*(Fatal signal\s+\d+\s+\([^)]+\).*?)\s*$/i;

export function extractStackTrace(reportText: string | undefined): StackTraceExtraction {
  const lines = (reportText ?? "").split(/\r?\n/);
  const frames: StackTraceFrame[] = [];
  const malformedLines: string[] = [];
  let exceptionType: string | undefined;
  let exceptionMessage: string | undefined;
  let thread: string | undefined;
  let signal: string | undefined;
  let sawTraceContext = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const threadMatch = THREAD_PATTERN.exec(line);

    if (!thread && threadMatch) {
      thread = threadMatch[1];
      sawTraceContext = true;
      continue;
    }

    const signalMatch = FATAL_SIGNAL_PATTERN.exec(line);

    if (!signal && signalMatch) {
      signal = signalMatch[1];
      sawTraceContext = true;
      continue;
    }

    const causedByMatch = CAUSED_BY_PATTERN.exec(line);

    if (causedByMatch) {
      exceptionType = causedByMatch[1];
      exceptionMessage = causedByMatch[2];
      sawTraceContext = true;
      continue;
    }

    const exceptionMatch = EXCEPTION_PATTERN.exec(line);

    if (!exceptionType && exceptionMatch) {
      exceptionType = exceptionMatch[1];
      exceptionMessage = exceptionMatch[2];
      sawTraceContext = true;
      continue;
    }

    const javaFrame = parseJavaFrame(line);

    if (javaFrame) {
      frames.push(javaFrame);
      sawTraceContext = true;
      continue;
    }

    const nativeFrame = parseNativeFrame(line);

    if (nativeFrame) {
      frames.push(nativeFrame);
      sawTraceContext = true;
      continue;
    }

    if (sawTraceContext && looksLikeMalformedFrame(line)) {
      malformedLines.push(trimmed);
    }
  }

  return stackTraceExtractionSchema.parse({
    exceptionType,
    exceptionMessage,
    signal,
    thread,
    frames,
    rawTopFrame: frames[0]?.raw,
    malformedLines: malformedLines.slice(0, 10),
    truncated: malformedLines.length > 10
  });
}

function parseJavaFrame(line: string): StackTraceFrame | null {
  const match = JAVA_FRAME_PATTERN.exec(line);

  if (!match) {
    return null;
  }

  const symbol = match[1].trim();
  const source = match[2].trim();
  const separator = symbol.lastIndexOf(".");
  const declaringClass = separator === -1 ? undefined : symbol.slice(0, separator);
  const method = separator === -1 ? symbol : symbol.slice(separator + 1);
  const sourceMatch = /^(.*?):(\d+)$/.exec(source);
  const sourceFile = sourceMatch?.[1];
  const unknownSource = source === "Unknown Source" || sourceFile === "Unknown Source";
  const native = source === "Native Method";
  const file =
    sourceMatch && sourceFile && !unknownSource && sourceFile !== "SourceFile"
      ? sourceFile
      : source && !native && !unknownSource && source !== "SourceFile"
        ? source
        : undefined;

  return {
    raw: line.trim(),
    declaringClass,
    method,
    file,
    line: sourceMatch ? Number(sourceMatch[2]) : undefined,
    native,
    unknownSource
  };
}

function parseNativeFrame(line: string): StackTraceFrame | null {
  const match = NATIVE_FRAME_PATTERN.exec(line);

  if (!match) {
    return null;
  }

  return {
    raw: line.trim(),
    file: match[1].trim()
  };
}

function looksLikeMalformedFrame(line: string): boolean {
  return /^\s*(?:at\b|#\d+\b|Caused by:)/.test(line);
}
