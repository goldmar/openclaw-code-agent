import { Type } from "../tool-parameter-schema";
import { sessionToolError } from "./session-tool-error";

/** Public tool spelling; internal session and backend identities are unchanged. */
export function sessionReferenceProperties() {
  return {
    ocaSessionId: Type.Optional(Type.String({ minLength: 1, description: "Exact OCA session ID or supported session name. Prefer the ID from the launch receipt." })),
    session: Type.Optional(Type.String({ minLength: 1, description: "Deprecated alias for ocaSessionId. Prefer ocaSessionId; if both are supplied they must match exactly." })),
  };
}

export const requiredSessionReference = {
  anyOf: [{ required: ["ocaSessionId"] }, { required: ["session"] }],
};

/** Validate both spellings before lookup; never let an invalid filter become all sessions. */
export function normalizeSessionReferenceParams(value: unknown, required = true):
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: ReturnType<typeof sessionToolError> } {
  const invalid = () => ({ ok: false as const, error: sessionToolError(
    "invalid_parameters",
    "Error: Invalid parameters. Use ocaSessionId (or legacy session) with a nonblank reference; supplied aliases must match exactly.",
  ) });
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  // This proposed spelling was never shipped. Refuse it instead of ignoring a filter.
  if ("codeAgentSessionId" in input) return invalid();
  const hasCanonical = "ocaSessionId" in input;
  const hasLegacy = "session" in input;
  for (const key of ["ocaSessionId", "session"] as const) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "string") return invalid();
    if (!input[key].trim()) return { ok: false, error: sessionToolError(
      "session_reference_unusable", "Error: The session reference is blank and cannot select a target.", false,
    ) };
  }
  if (hasCanonical && hasLegacy && input.ocaSessionId !== input.session) return invalid();
  if (required && !hasCanonical && !hasLegacy) return invalid();
  const { session: _legacy, ...params } = input;
  if (hasCanonical || hasLegacy) params.ocaSessionId = hasCanonical ? input.ocaSessionId : input.session;
  return { ok: true, params };
}
