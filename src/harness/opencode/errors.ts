export class OpenCodeApiError extends Error {
  constructor(
    readonly status: number,
    readonly _tag: string,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeApiError";
  }
}
export class OpenCodeVersionError extends Error {
  constructor() {
    super(
      "OpenCode requires >= 2.0.25 from @opencode/cli (opencode2). OpenCode 1.x is not supported.",
    );
    this.name = "OpenCodeVersionError";
  }
}
export function classifyApiError(error: unknown): string {
  if (error instanceof OpenCodeVersionError) return "opencode_version";
  if (error instanceof OpenCodeApiError)
    return error.status === 401 ? "opencode_auth" : error._tag;
  return "opencode_transport";
}
export function isSettledError(e: unknown): boolean {
  return (
    e instanceof OpenCodeApiError &&
    (e.status === 404 || /(?:Settled|NotFound)/.test(e._tag))
  );
}

export function isConnectionResetError(error: unknown): boolean {
  const e = error as { code?: string; cause?: unknown };
  return (
    !!e &&
    (["ECONNRESET", "UND_ERR_SOCKET"].includes(e.code ?? "") ||
      (!!e.cause && isConnectionResetError(e.cause)))
  );
}
