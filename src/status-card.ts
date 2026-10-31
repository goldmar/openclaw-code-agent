/** Callback-bound editors always address the existing, authenticated decision card. */
export class StatusCards {
  private readonly cards = new Map<string, { edit: (text: string) => Promise<void>; pending: Promise<void>; held: boolean; lastText?: string }>();

  register(ref: string, edit: (text: string) => Promise<void>): void {
    if (this.cards.size >= 1000) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(ref, { edit, pending: Promise.resolve(), held: false });
  }

  update(ref: string, text: string): boolean {
    const card = this.cards.get(ref);
    if (!card) return false;
    // Serialize transitions: a slow acknowledgement cannot overwrite delegation.
    card.pending = card.pending.then(async () => {
      if (card.held || card.lastText === text) return;
      try { await card.edit(text); card.lastText = text; }
      catch { card.held = true; } // no duplicate standalone acknowledgement on an unknown edit
    });
    return true;
  }

  inherit(source: string, target: string): void {
    const card = this.cards.get(source);
    if (card) this.cards.set(target, card);
  }
}
