/** Only a resolved, matching plan card may lose its decision buttons. */
export class StatusCards {
  private readonly cards = new Map<string, { edit: (text: string) => Promise<void>; text: string; version: number; pending: Promise<unknown>; held: boolean; approved?: boolean }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  forget(ref: string): void { this.cards.delete(ref); }

  register(ref: string, edit: (text: string) => Promise<void>, text = ""): void {
    const heading = /^📋 \[[^\n]+\] Plan v(\d+) (?:ready for approval|needs your decision)\n/.exec(text);
    // Chunked plans and unrelated live decision cards require a standalone ack.
    if (!heading) { this.cards.delete(ref); return; }
    if (this.cards.size >= 1000) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(ref, { edit, text, version: Number(heading[1]), pending: Promise.resolve(), held: false });
  }

  async approve(ref: string, resolvedVersion: number | undefined, now = this.now(), acknowledgement?: string): Promise<boolean> {
    const card = this.cards.get(ref);
    if (!card || card.version !== resolvedVersion) return false;
    const result = card.pending.then(async () => {
      if (card.held) return false;
      if (card.approved) return true;
      try {
        await card.edit(approvedPlanCard(card.text, now, acknowledgement));
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

export function approvedPlanCard(original: string, now: Date, acknowledgement?: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const rationale = acknowledgement?.split("\n").filter((line) => line.startsWith("Why: ")).join("\n");
  const footer = `\n\n👍 Approved ${time} PT${rationale ? "\n" + rationale : ""}`;
  const [header, ...lines] = original.split("\n");
  const body = lines.join("\n");
  const allowance = 4096 - header!.length - 1 - footer.length;
  // Reserve the footer first; avoid cutting a UTF-16 surrogate pair in the plan.
  const trimmed = body.length > allowance
    ? body.slice(0, allowance - 1).replace(/[\uD800-\uDBFF]$/, "") + "…" : body;
  return `${header}\n${trimmed}${footer}`;
}
