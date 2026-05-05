import { createHash } from "crypto";

import { CALLBACK_NAMESPACE } from "./interactive-constants";

type ButtonLike = {
  label?: unknown;
  callbackData?: unknown;
  value?: unknown;
  style?: unknown;
};

type ButtonRows = Array<Array<ButtonLike>>;

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function areButtonDiagnosticsEnabled(): boolean {
  const value = process.env.OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS?.trim().toLowerCase();
  return Boolean(value && ENABLED_VALUES.has(value));
}

export function hashDiagnosticToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function callbackValue(button: ButtonLike): string | undefined {
  return typeof button.callbackData === "string"
    ? button.callbackData
    : typeof button.value === "string"
      ? button.value
      : undefined;
}

export function summarizeButtons(buttons: ButtonRows | undefined): Record<string, unknown> {
  const rows = (buttons ?? []).filter((row) => Array.isArray(row) && row.length > 0);
  const flattened = rows.flat();
  return {
    buttonRows: rows.length || undefined,
    buttonCount: flattened.length || undefined,
    buttonLabels: flattened.length > 0
      ? flattened.map((button) => typeof button.label === "string" ? button.label : undefined)
      : undefined,
    callbackByteLengths: flattened.length > 0
      ? flattened.map((button) => {
          const value = callbackValue(button);
          return value ? Buffer.byteLength(value, "utf8") : undefined;
        })
      : undefined,
    callbackHashes: flattened.length > 0
      ? flattened.map((button) => hashDiagnosticToken(callbackValue(button)))
      : undefined,
    buttonStyles: flattened.length > 0
      ? flattened.map((button) => typeof button.style === "string" ? button.style : undefined)
      : undefined,
  };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function collectBlockTypes(value: unknown): string[] | undefined {
  const record = toRecord(value);
  const blocks = Array.isArray(record?.blocks) ? record.blocks : undefined;
  if (!blocks) return undefined;
  return blocks
    .map((block) => toRecord(block)?.type)
    .filter((type): type is string => typeof type === "string" && type.length > 0);
}

function collectInteractiveButtons(value: unknown): ButtonRows | undefined {
  const record = toRecord(value);
  const blocks = Array.isArray(record?.blocks) ? record.blocks : undefined;
  if (!blocks) return undefined;
  const rows = blocks
    .map((block) => {
      const blockRecord = toRecord(block);
      if (blockRecord?.type !== "buttons" || !Array.isArray(blockRecord.buttons)) return [];
      return blockRecord.buttons as ButtonLike[];
    })
    .filter((row) => row.length > 0);
  return rows.length > 0 ? rows : undefined;
}

export function summarizePresentation(value: unknown): Record<string, unknown> {
  const buttons = collectInteractiveButtons(value);
  return {
    presentationBlockTypes: collectBlockTypes(value),
    ...summarizeButtons(buttons),
  };
}

export function summarizeRenderedPayload(value: unknown): Record<string, unknown> {
  const record = toRecord(value);
  const interactive = record?.interactive;
  const channelData = toRecord(record?.channelData);
  const telegramData = toRecord(channelData?.telegram);
  const telegramButtons = Array.isArray(telegramData?.buttons)
    ? telegramData.buttons as ButtonRows
    : undefined;

  return {
    renderedPayloadKeys: record ? Object.keys(record).sort() : undefined,
    interactiveBlockTypes: collectBlockTypes(interactive),
    ...prefixKeys("interactive", summarizeButtons(collectInteractiveButtons(interactive))),
    ...prefixKeys("telegramChannelData", summarizeButtons(telegramButtons)),
    hasPresentation: Boolean(record?.presentation),
    hasInteractive: Boolean(interactive),
    hasTelegramChannelDataButtons: Boolean(telegramButtons?.some((row) => row.length > 0)),
  };
}

export function summarizeSendResult(value: unknown): Record<string, unknown> {
  const record = toRecord(value);
  if (!record) return { sendResultType: typeof value };
  return {
    sendResultKeys: Object.keys(record).sort(),
    messageId: stringOrNumber(record.messageId),
    chatId: stringOrNumber(record.chatId),
    telegramThreadId: stringOrNumber(record.messageThreadId ?? record.threadId),
    channel: typeof record.channel === "string" ? record.channel : undefined,
  };
}

function stringOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function prefixKeys(prefix: string, values: Record<string, unknown>): Record<string, unknown> {
  const prefixed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      prefixed[`${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value;
    }
  }
  return prefixed;
}

export function logButtonDiagnostic(event: string, fields: Record<string, unknown>): void {
  if (!areButtonDiagnosticsEnabled()) return;
  const sanitized = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  console.info(`[CodeAgentButtonDiagnostics] ${JSON.stringify({
    event,
    callbackNamespace: CALLBACK_NAMESPACE,
    ...sanitized,
  })}`);
}
