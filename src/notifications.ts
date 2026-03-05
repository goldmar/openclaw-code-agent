/** Summarize tool input for compact display. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";

  const payload = input as Record<string, unknown>;
  if (typeof payload.file_path === "string") return truncate(payload.file_path, 60);
  if (typeof payload.path === "string") return truncate(payload.path, 60);
  if (typeof payload.command === "string") return truncate(payload.command, 80);
  if (typeof payload.pattern === "string") return truncate(payload.pattern, 60);
  if (typeof payload.glob === "string") return truncate(payload.glob, 60);

  const firstValue = Object.values(payload).find((v) => typeof v === "string" && v.length > 0);
  if (firstValue) return truncate(String(firstValue), 60);
  return "";
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}
