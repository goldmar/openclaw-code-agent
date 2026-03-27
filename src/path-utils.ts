import { existsSync, realpathSync } from "fs";
import { resolve } from "path";

export function canonicalizePath(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const resolved = resolve(input);
  try {
    if (existsSync(resolved)) {
      return realpathSync.native(resolved);
    }
  } catch {
    // Fall through to lexical resolution.
  }
  return resolved;
}

export function pathsReferToSameLocation(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  return canonicalizePath(left) === canonicalizePath(right);
}
