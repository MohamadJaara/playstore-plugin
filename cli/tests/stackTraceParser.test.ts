import { describe, expect, it } from "vitest";

import { extractStackTrace } from "../src/domain/stackTraceParser.js";

describe("extractStackTrace", () => {
  it("extracts Java and Kotlin stack frames from crash reports", () => {
    const trace = extractStackTrace(
      [
        "java.lang.IllegalStateException: Bad state",
        "    at com.example.MainActivity.onCreate(MainActivity.kt:42)",
        "    at com.example.Repository.load(Repository.java:17)",
        "Caused by: java.lang.IllegalArgumentException: Missing id",
        "    at com.example.Repository.requireId(Repository.kt:12)"
      ].join("\n")
    );

    expect(trace.exceptionType).toBe("java.lang.IllegalArgumentException");
    expect(trace.exceptionMessage).toBe("Missing id");
    expect(trace.rawTopFrame).toBe("at com.example.MainActivity.onCreate(MainActivity.kt:42)");
    expect(trace.frames).toEqual([
      expect.objectContaining({
        declaringClass: "com.example.MainActivity",
        method: "onCreate",
        file: "MainActivity.kt",
        line: 42
      }),
      expect.objectContaining({
        declaringClass: "com.example.Repository",
        method: "load",
        file: "Repository.java",
        line: 17
      }),
      expect.objectContaining({
        declaringClass: "com.example.Repository",
        method: "requireId",
        file: "Repository.kt",
        line: 12
      })
    ]);
    expect(trace.malformedLines).toEqual([]);
  });

  it("extracts ANR thread names and native frames", () => {
    const trace = extractStackTrace(
      [
        '"main" prio=5 tid=1 Blocked',
        "    at android.os.BinderProxy.transactNative(Native Method)",
        "    at android.os.BinderProxy.transact(BinderProxy.java:640)",
        "#00 pc 0000000000012345 /apex/com.android.runtime/lib64/bionic/libc.so (syscall+32)"
      ].join("\n")
    );

    expect(trace.thread).toBe("main");
    expect(trace.frames).toEqual([
      expect.objectContaining({
        declaringClass: "android.os.BinderProxy",
        method: "transactNative",
        native: true
      }),
      expect.objectContaining({
        declaringClass: "android.os.BinderProxy",
        method: "transact",
        file: "BinderProxy.java",
        line: 640
      }),
      expect.objectContaining({
        file: "/apex/com.android.runtime/lib64/bionic/libc.so (syscall+32)"
      })
    ]);
  });

  it("keeps malformed stack traces non-fatal and reports malformed lines", () => {
    const trace = extractStackTrace(
      [
        "java.lang.RuntimeException: malformed",
        "    at",
        "#00 pc not-hex /bad/frame",
        "    at com.example.Valid.run(Valid.kt:9)"
      ].join("\n")
    );

    expect(trace.frames).toEqual([
      expect.objectContaining({
        declaringClass: "com.example.Valid",
        method: "run",
        file: "Valid.kt",
        line: 9
      })
    ]);
    expect(trace.malformedLines).toEqual(["at", "#00 pc not-hex /bad/frame"]);
    expect(trace.truncated).toBe(false);
  });

  it("returns an empty extraction for missing report text", () => {
    expect(extractStackTrace(undefined)).toEqual({
      frames: [],
      malformedLines: [],
      truncated: false
    });
  });
});
