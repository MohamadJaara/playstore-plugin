export type OutputFormat = "json" | "markdown";

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printMarkdown(markdown: string): void {
  console.log(markdown);
}
