export type SessionToolErrorCode = "session_not_found" | "session_reference_unusable" | "service_unavailable" | "invalid_parameters" | "session_target_changed";

export function sessionToolError(code: SessionToolErrorCode, text: string, targetSelected?: boolean) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
    details: {
      status: "error" as const,
      code,
      operationStarted: false,
      ...(targetSelected === undefined ? {} : { targetSelected }),
      recovery: "Use the original launch receipt or an authorized existing session lookup to select the intended exact OCA ID.",
    },
  };
}

/** Resolve first: a literal masked-looking name may be a legitimate exact name. */
export function unknownSessionError(ref: string) {
  const unusable = !ref.trim() || ref.includes("***");
  return sessionToolError(
    unusable ? "session_reference_unusable" : "session_not_found",
    unusable
      ? "Error: The session reference is blank or masked-looking and did not resolve."
      : "Error: Session not found for the supplied reference.",
    false,
  );
}
