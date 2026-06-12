import { createHash } from "crypto";
import { appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const OUTPUT_BUFFER_MAX = 2000;
const SAFE_SESSION_OUTPUT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

function getPathSafeSessionOutputId(sessionId: string): string {
  if (SAFE_SESSION_OUTPUT_ID_PATTERN.test(sessionId)) return sessionId;
  return `hashed+${createHash("sha256").update(sessionId, "utf8").digest("hex")}`;
}

export function getSessionOutputFilePath(sessionId: string): string {
  return join(tmpdir(), `openclaw-agent-${getPathSafeSessionOutputId(sessionId)}.txt`);
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
    appendFileSync(getSessionOutputFilePath(sessionId), text, "utf-8");
  } catch {
    // best-effort; don't let disk errors interrupt the session
  }
  return outputBuffer;
}
