import path from "node:path";

/** @param {unknown} value @returns {unknown} */
export function redactProofValue(value) {
  if (typeof value === "string") {
    return value
      .replace(/\bauthorization\b(?:(\s*[:=]\s*)|\s+)(?:"(?:Bearer\s+)?[^"]+"|'(?:Bearer\s+)?[^']+'|(?:Bearer\s+)?[A-Za-z0-9._~+/-]+=*)/giu, "authorization$1[redacted credential]")
      .replace(/\b(secret|password|api[-_ ]?key|credential|token)\b(?:(\s*[:=]\s*)|\s+)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/giu, "$1$2[redacted credential]")
      .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted credential]")
      .replace(/\b\d{7,}:[A-Za-z0-9_-]{20,}\b/gu, "[redacted credential]")
      .replace(/\b\d{6,}\b/gu, "[redacted id]")
      .replace(/@[A-Za-z][A-Za-z0-9_]{4,}\b/gu, "@[redacted username]")
      .replace(/\+?\d[\d .().-]{7,}\d/gu, "[redacted phone]")
      .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opsru]_[A-Za-z0-9_]{8,}|[A-Za-z0-9_-]{32,})\b/g, "[redacted token]")
      .replace(/\/(?:Users|home|tmp|private\/tmp|var\/folders|workspace|run\/user)\/[^\s"',}\]]+/g, "[redacted path]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactProofValue(entry));
  if (!value || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(api[_-]?key|token|secret|password|authorization|credential|groupId|testerUserId|ownerId|username|messageId|callback.*data|^data$)/iu.test(key)) {
      output[key] = "[redacted credential]";
      continue;
    }
    if (/(^|[_-])(cwd|path|dir|directory|worktree|output)([_-]|$)/iu.test(key) && typeof entry === "string" && path.isAbsolute(entry)) {
      output[key] = "[redacted path]";
      continue;
    }
    output[key] = redactProofValue(entry);
  }
  return output;
}
