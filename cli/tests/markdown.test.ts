import { describe, expect, it } from "vitest";

import { escapeMarkdownTableCell } from "../src/utils/markdown.js";

describe("escapeMarkdownTableCell", () => {
  it("escapes every pipe in markdown table cells", () => {
    expect(escapeMarkdownTableCell("alpha|beta|gamma")).toBe(String.raw`alpha\|beta\|gamma`);
  });

  it("escapes backslashes before adding pipe escapes", () => {
    expect(escapeMarkdownTableCell(String.raw`device\|model`)).toBe(String.raw`device\\\|model`);
    expect(escapeMarkdownTableCell(String.raw`C:\tmp|Pixel`)).toBe(String.raw`C:\\tmp\|Pixel`);
  });
});
