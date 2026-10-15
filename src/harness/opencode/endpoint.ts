import type { OpenCodeClient } from "./client";
import { OpenCodeApiError, OpenCodeVersionError } from "./errors";
export const MIN_OPENCODE_VERSION = "2.0.29";
export interface OpenCodeServerHandle {
  baseUrl: string;
  authorization?: string;
  close(): Promise<void>;
  onExit?(listener: (reason: string) => void): void;
}
export interface EndpointLease {
  client: OpenCodeClient;
  generation: number;
  info: { version: string };
  baseUrl: string;
  authorization?: string;
  onLost(listener: (reason: string) => void): void;
  release(): Promise<void>;
}
export interface OpenCodeEndpoint {
  acquire(): Promise<EndpointLease>;
}
export async function checkServerVersion(
  client: OpenCodeClient,
): Promise<{ version: string }> {
  try {
    const info = await client.data("GET /api/info");
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(info.version);
    if (
      !match ||
      Number(match[1]) !== 2 ||
      (Number(match[2]) === 0 && Number(match[3]) < 29)
    )
      throw new OpenCodeVersionError();
    return info;
  } catch (e) {
    if (
      e instanceof OpenCodeApiError &&
      (e.status === 404 || e._tag === "non_json")
    )
      throw new OpenCodeVersionError();
    throw e;
  }
}
