/** Normalize only declared boolean fields, then validate the complete typed input.
 * Invalid values fail distinctly from omission. The caller's object is never changed.
 */
export function normalizeBooleanParams<T>(
  value: unknown,
  keys: readonly string[],
  validate: (value: unknown) => value is T,
): T | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params: Record<string, unknown> = { ...value };
  for (const key of keys) {
    const raw = params[key];
    if (raw === "true") params[key] = true;
    else if (raw === "false") params[key] = false;
    else if (raw !== undefined && typeof raw !== "boolean") return undefined;
  }
  return validate(params) ? params : undefined;
}
