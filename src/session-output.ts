import { createHash } from "crypto";
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { resolveSessionOutputDir } from "./state-paths";

const OUTPUT_BUFFER_MAX = 2000;
const SAFE_SESSION_OUTPUT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

function getPathSafeSessionOutputId(sessionId: string): string {
  if (SAFE_SESSION_OUTPUT_ID_PATTERN.test(sessionId)) return sessionId;
  return `hashed+${createHash("sha256").update(sessionId, "utf8").digest("hex")}`;
}

export const SESSION_OUTPUT_FILE_PREFIX = "openclaw-agent-";
export const SESSION_OUTPUT_FILE_SUFFIX = ".txt";

/** `<stateDir>/plugin-state/openclaw-code-agent/output/openclaw-agent-<id>.txt` */
export function getSessionOutputFilePath(sessionId: string): string {
  return join(
    resolveSessionOutputDir(),
    `${SESSION_OUTPUT_FILE_PREFIX}${getPathSafeSessionOutputId(sessionId)}${SESSION_OUTPUT_FILE_SUFFIX}`,
  );
}

/** Create the private output directory (no-op when it already exists). */
export function ensureSessionOutputDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function appendTextToOutputBuffer(outputBuffer: string[], text: string): void {
  if (!text) return;

  const segments = text.split("\n");
  const [firstSegment = "", ...remainingSegments] = segments;

  if (outputBuffer.length === 0) {
    outputBuffer.push(firstSegment);
  } else {
    outputBuffer[outputBuffer.length - 1] += firstSegment;
  }

  for (const segment of remainingSegments) {
    outputBuffer.push(segment);
  }
}

export function appendSessionOutput(outputBuffer: string[], sessionId: string, text: string): string[] {
  appendTextToOutputBuffer(outputBuffer, text);
  if (outputBuffer.length > OUTPUT_BUFFER_MAX) {
    outputBuffer.splice(0, outputBuffer.length - OUTPUT_BUFFER_MAX);
  }
  try {
    const outputPath = getSessionOutputFilePath(sessionId);
    ensureSessionOutputDir(outputPath);
    appendFileSync(outputPath, text, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // best-effort; don't let disk errors interrupt the session
  }
  return outputBuffer;
}
