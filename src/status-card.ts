import { getPluginRuntime, getRuntimeConfig } from "./runtime-store";

export type StatusCardIdentity = { messageId?: string; sentAt?: Date };

/** Only a resolved, matching plan card may lose its decision buttons. */
export class StatusCards {
  private readonly cards = new Map<string, { edit: (text: string) => Promise<void>; text: string; version: number; pending: Promise<unknown>; held: boolean; approved?: boolean; messageId?: string; sentAt?: Date }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  forget(ref: string): void { this.cards.delete(ref); }

  register(ref: string, edit: (text: string) => Promise<void>, text = "", identity: StatusCardIdentity = {}): void {
    const heading = /^📋 \[[^\n]+\] Plan v(\d+) (?:ready for approval|needs your decision)(?: \| [^\n]*)?\n/.exec(text);
    // Chunked plans and unrelated live decision cards require a standalone ack.
    if (!heading) { this.cards.delete(ref); return; }
    const previous = this.cards.get(ref);
    const sentAt = identity.sentAt ?? (identity.messageId && previous?.messageId === identity.messageId ? previous.sentAt : undefined);
    if (this.cards.size >= 1000) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(ref, { edit, text, version: Number(heading[1]), pending: Promise.resolve(), held: false, messageId: identity.messageId, sentAt });
  }

  async approve(ref: string, resolvedVersion: number | undefined, now = this.now(), acknowledgement?: string): Promise<boolean> {
    const card = this.cards.get(ref);
    if (!card || card.version !== resolvedVersion) return false;
    const result = card.pending.then(async () => {
      if (card.held) return false;
      if (card.approved) return true;
      try {
        await card.edit(approvedPlanCard(card.text, now, acknowledgement, card.sentAt));
        card.approved = true;
        return true;
      } catch { card.held = true; return false; }
    });
    card.pending = result;
    return result;
  }

  inherit(source: string, target: string): void {
    const card = this.cards.get(source);
    if (card) this.cards.set(target, card);
  }
}

export function approvedPlanCard(original: string, now: Date, acknowledgement?: string, sentAt?: Date): string {
  const timeZone = userTimezone();
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(now);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const approvalDay = date.format(now);
  const approvalDate = !sentAt || date.format(sentAt) !== approvalDay ? `${approvalDay} ` : "";
  const rationale = acknowledgement?.split("\n").filter((line) => line.startsWith("Why: ")).join("\n");
  const footer = `\n\n👍 Approved ${approvalDate}${time}${rationale ? "\n" + rationale : ""}`;
  const [header, ...lines] = original.split("\n");
  const body = lines.join("\n").replace(/\n\nChoose Approve, Revise, or Reject below\.\s*$/u, "");
  const allowance = 4096 - header!.length - 1 - footer.length;
  // Reserve the footer first; avoid cutting a UTF-16 surrogate pair in the plan.
  const trimmed = body.length > allowance
    ? body.slice(0, allowance - 1).replace(/[\uD800-\uDBFF]$/, "") + "…" : body;
  return `${header}\n${trimmed}${footer}`;
}

/** Follow OpenClaw's agents.defaults.userTimezone and host-timezone fallback. */
function userTimezone(): string {
  let current: unknown;
  try { current = getPluginRuntime()?.config.current(); } catch { /* use the service snapshot */ }
  const config = (current ?? getRuntimeConfig()) as { agents?: { defaults?: { userTimezone?: unknown } } } | undefined;
  const configured = config?.agents?.defaults?.userTimezone;
  if (typeof configured === "string" && configured.trim()) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: configured.trim() });
      return configured.trim();
    } catch { /* invalid configuration falls back like OpenClaw */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
