import type { DiffSummary } from "./worktree";

export interface PrMetadataEvidence {
  sessionName: string;
  objective?: string;
  stats?: {
    commits: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  changedFiles: string[];
  commitSubjects: string[];
  validation: string[];
  notes: string[];
}

export interface PrMetadata {
  title: string;
  summary: string[];
  changes: string[];
  validation: string[];
  notes: string[];
}

export interface PrMetadataProvider {
  generatePrMetadata(evidence: PrMetadataEvidence): Promise<unknown>;
}

export type PrMetadataResult =
  | { ok: true; metadata: PrMetadata; evidence: PrMetadataEvidence }
  | { ok: false; error: string; evidence: PrMetadataEvidence };

const OPAQUE_TOKEN_MIN_LENGTH = 32;

function normalizePrText(value: string | undefined, options: { preserveBlankLines?: boolean } = { preserveBlankLines: true }): string | undefined {
  const text = value
    ?.replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .reduce<string[]>((acc, line) => {
      if (!line) {
        if (options.preserveBlankLines && acc[acc.length - 1] !== "") acc.push(line);
        return acc;
      }
      acc.push(line);
      return acc;
    }, [])
    .join(options.preserveBlankLines ? "\n" : " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return text || undefined;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credential|credentials|authorization|auth)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[^"'\s,;)]+/gi, "[redacted credential]")
    .replace(/\b(?:api key|token|secret|password|credential|credentials)\s+\[redacted credential\]/gi, "[redacted credential]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g, "[redacted token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[redacted token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted token]")
    .replace(/\bhttps?:\/\/\S+/gi, "[redacted link]")
    .replace(/\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\s`'")]+/gi, "[redacted path]")
    .replace(/(?:^|[\s(])\/(?:home|Users|var|etc|private|tmp)\/[^\s`'").]+/g, (match) => `${match.startsWith(" ") || match.startsWith("(") ? match[0] : ""}[redacted path]`)
    .replace(new RegExp(`\\b[A-Za-z0-9_-]{${OPAQUE_TOKEN_MIN_LENGTH},}\\b`, "g"), "[redacted token]");
}

function containsSensitiveText(value: string): boolean {
  return /\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credential|credentials|authorization|auth)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[^"'\s,;)]+/i.test(value)
    || /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
    || /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/.test(value)
    || /\bhttps?:\/\/\S+/i.test(value)
    || /\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\s`'")]+/i.test(value)
    || /(?:^|[\s(])\/(?:home|Users|var|etc|private|tmp)\/[^\s`'").]+/.test(value)
    || new RegExp(`\\b[A-Za-z0-9_-]{${OPAQUE_TOKEN_MIN_LENGTH},}\\b`).test(value);
}

function buildSafeObjective(prompt: string | undefined): string | undefined {
  const normalized = normalizePrText(prompt);
  if (!normalized) return undefined;
  const firstSentence = normalized.match(/^[^.!?]+[.!?]/)?.[0] ?? normalized;
  const redacted = redactSensitiveText(firstSentence).replace(/\s+/g, " ").trim();
  return redacted ? truncateText(redacted, 180) : undefined;
}

function formatSafeCommitSubject(message: string): string {
  return redactSensitiveText(message.trim()).replace(/\s+/g, " ").trim();
}

function formatCommitSubjects(diffSummary: DiffSummary | undefined, limit: number): string[] {
  return diffSummary?.commitMessages
    .map((commit) => formatSafeCommitSubject(commit.message))
    .filter(Boolean)
    .slice(0, limit) ?? [];
}

function defaultValidation(): string[] {
  return ["Not recorded by agent_pr. Review CI/checks and session output before merging."];
}

function defaultNotes(): string[] {
  return [
    "Generated PR metadata omits full task prompts and redacts sensitive-looking prompt details.",
    "Review touched areas for behavior, security, and privacy impact.",
  ];
}

function buildPrMetadataEvidence(args: {
  sessionName: string;
  prompt?: string;
  diffSummary?: DiffSummary;
}): PrMetadataEvidence {
  const objective = buildSafeObjective(args.prompt);
  const diffSummary = args.diffSummary;
  return {
    sessionName: args.sessionName,
    objective,
    stats: diffSummary
      ? {
          commits: diffSummary.commits,
          filesChanged: diffSummary.filesChanged,
          insertions: diffSummary.insertions,
          deletions: diffSummary.deletions,
        }
      : undefined,
    changedFiles: diffSummary?.changedFiles ?? [],
    commitSubjects: formatCommitSubjects(diffSummary, 5),
    validation: defaultValidation(),
    notes: defaultNotes(),
  };
}

function isStringArray(value: unknown, maxItems: number, maxItemLength: number): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= maxItems
    && value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maxItemLength);
}

function promptLeakFragments(prompt: string | undefined, allowedObjective: string | undefined): string[] {
  const normalized = normalizePrText(prompt);
  if (!normalized) return [];
  const allowed = allowedObjective?.toLowerCase();
  return normalized
    .split(/[.!?\n]/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 24)
    .filter((fragment) => !allowed || fragment.toLowerCase() !== allowed.replace(/[.!?]$/, ""))
    .map((fragment) => fragment.toLowerCase());
}

function includesPromptLeak(value: string, prompt: string | undefined, evidence: PrMetadataEvidence): boolean {
  const lower = value.toLowerCase();
  return promptLeakFragments(prompt, evidence.objective).some((fragment) => lower.includes(fragment));
}

function isLikelyDottedTechnologyName(value: string): boolean {
  return /^(?:node|next|nuxt|vue|express|nest|three|d3|chart|ember|backbone|require)\.js$/i.test(value);
}

function mentionsUnknownFile(value: string, evidence: PrMetadataEvidence): boolean {
  const knownFiles = new Set(evidence.changedFiles);
  const pathMatches = [...value.matchAll(/(?:^|[^\w.-])((?:\.?[\w-][\w.-]*\/)+(?:\.?[\w-][\w.-]*))(?![\w.-])/g)].map((match) => match[1]);
  if (pathMatches.some((file) => /\.[A-Za-z0-9]+$/.test(file) && !knownFiles.has(file))) return true;

  const knownRootFiles = new Set(evidence.changedFiles.filter((file) => !file.includes("/")));
  const hiddenRootFilePattern = String.raw`\.[a-z0-9][\w.-]*`;
  const quotedHiddenRootFileMentions = value.matchAll(new RegExp(`[\\\`"'](${hiddenRootFilePattern})[\\\`"']`, "g"));
  for (const match of quotedHiddenRootFileMentions) {
    if (!knownRootFiles.has(match[1])) return true;
  }

  const contextualHiddenRootFileMentions = value.matchAll(new RegExp(String.raw`\b(?:file|files|path|paths|changed|changes|updated?|updates?|modified?|modifies|touched?|touches|added?|adds?|removed?|removes?|deleted?|deletes?)\s+(?:the\s+)?(${hiddenRootFilePattern})(?![\w.-])`, "gi"));
  for (const match of contextualHiddenRootFileMentions) {
    if (!knownRootFiles.has(match[1])) return true;
  }

  if (knownRootFiles.size === 0) return false;

  const knownRootExtensions = new Set(
    [...knownRootFiles]
      .map((file) => file.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase())
      .filter((extension): extension is string => Boolean(extension)),
  );
  const rootFilePattern = String.raw`[A-Za-z0-9][\w.-]*\.([A-Za-z0-9]+)`;
  const quotedRootFileMentions = value.matchAll(new RegExp(`[\\\`"'](${rootFilePattern})[\\\`"']`, "g"));
  for (const match of quotedRootFileMentions) {
    const file = match[1];
    const extension = match[2]?.toLowerCase();
    if (extension !== undefined && knownRootExtensions.has(extension) && !knownRootFiles.has(file) && !isLikelyDottedTechnologyName(file)) return true;
  }

  const contextualRootFileMentions = value.matchAll(new RegExp(String.raw`\b(?:file|files|path|paths|changed|changes|updated?|updates?|modified?|modifies|touched?|touches|added?|adds?|removed?|removes?|deleted?|deletes?)\s+(?:the\s+)?(${rootFilePattern})\b`, "gi"));
  return [...contextualRootFileMentions].some((match) => {
    const file = match[1];
    const extension = match[2]?.toLowerCase();
    return extension !== undefined
      && knownRootExtensions.has(extension)
      && !knownRootFiles.has(file)
      && !isLikelyDottedTechnologyName(file);
  });
}

function sanitizeMetadataText(value: string): string {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim();
}

function validateGeneratedPrMetadata(
  value: unknown,
  evidence: PrMetadataEvidence,
  prompt: string | undefined,
): PrMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim().length === 0 || raw.title.length > 90) return undefined;
  if (!isStringArray(raw.summary, 5, 180)) return undefined;
  if (!isStringArray(raw.changes, 10, 160)) return undefined;
  if (!isStringArray(raw.validation, 5, 160)) return undefined;
  if (!isStringArray(raw.notes, 5, 180)) return undefined;

  const rawText = [
    raw.title,
    ...raw.summary,
    ...raw.changes,
    ...raw.validation,
    ...raw.notes,
  ];
  if (rawText.some((item) => containsSensitiveText(item) || includesPromptLeak(item, prompt, evidence))) return undefined;

  const metadata: PrMetadata = {
    title: sanitizeMetadataText(raw.title),
    summary: raw.summary.map(sanitizeMetadataText),
    changes: raw.changes.map(sanitizeMetadataText),
    validation: raw.validation.map(sanitizeMetadataText),
    notes: raw.notes.map(sanitizeMetadataText),
  };

  const allText = [
    metadata.title,
    ...metadata.summary,
    ...metadata.changes,
    ...metadata.validation,
    ...metadata.notes,
  ];

  if (allText.some((item) => !item || containsSensitiveText(item) || includesPromptLeak(item, prompt, evidence))) return undefined;
  if (allText.some((item) => mentionsUnknownFile(item, evidence))) return undefined;
  return metadata;
}

export async function buildPrMetadata(args: {
  sessionName: string;
  prompt?: string;
  diffSummary?: DiffSummary;
  provider?: PrMetadataProvider;
}): Promise<PrMetadataResult> {
  const evidence = buildPrMetadataEvidence(args);
  if (!args.provider) {
    return {
      ok: false,
      error: "PR metadata generation requires an LLM metadata provider. Pass explicit title and body, or configure a provider before creating the PR.",
      evidence,
    };
  }

  try {
    const generated = await args.provider.generatePrMetadata(evidence);
    const metadata = validateGeneratedPrMetadata(generated, evidence, args.prompt);
    if (metadata) return { ok: true, metadata, evidence };
    return {
      ok: false,
      error: "LLM-generated PR metadata failed schema or safety validation. Pass explicit title/body or retry after correcting the provider output.",
      evidence,
    };
  } catch (err) {
    console.warn(`[agent_pr] PR metadata provider failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      error: "PR metadata provider failed. Pass explicit title/body or retry after the provider is healthy.",
      evidence,
    };
  }
}

export function formatPrBody(args: {
  sessionName: string;
  metadata: PrMetadata;
  diffSummary?: DiffSummary;
}): string {
  const lines: string[] = [
    `OpenClaw Code Agent session: ${args.sessionName}`,
    ``,
    `## Summary`,
    ...args.metadata.summary.map((line) => `- ${line}`),
    ``,
    `## Changes`,
    ...args.metadata.changes.map((line) => `- ${line}`),
    ``,
  ];

  if (args.diffSummary) {
    const commitMessages = args.diffSummary.commitMessages
      .slice(0, 5)
      .map((c) => `- ${c.hash} ${formatSafeCommitSubject(c.message)} (${c.author})`);
    const moreCommits = args.diffSummary.commits > 5 ? [`- ...and ${args.diffSummary.commits - 5} more`] : [];
    if (commitMessages.length > 0) {
      lines.push(`## Commits`, ...commitMessages, ...moreCommits, ``);
    }
  }

  lines.push(
    `## Validation`,
    ...args.metadata.validation.map((line) => `- ${line}`),
    ``,
    `## Notes / Risks`,
    ...args.metadata.notes.map((line) => `- ${line}`),
    ``,
  );

  lines.push(`---`, `Generated with [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)`);
  return lines.join("\n");
}
