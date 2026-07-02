const HARNESS_STARTUP_FAILURE_PATTERNS: readonly RegExp[] = [
  /\bfailed to authenticate\b/i,
  /\binvalid bearer token\b/i,
  /\bapi error:\s*401\b/i,
  /\b401\s+unauthori[sz]ed\b/i,
  /\binvalid api key\b/i,
  /\binvalid authentication\b/i,
  /\bauthentication failed\b/i,
  /\bauth(?:orization)? error\b/i,
];

export function isHarnessStartupFailureOutput(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  return HARNESS_STARTUP_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function summarizeHarnessStartupFailure(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => isHarnessStartupFailureOutput(line)) ?? lines.at(-1);
}
