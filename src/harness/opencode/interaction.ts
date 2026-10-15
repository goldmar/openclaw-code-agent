import type {
  S_Form_Info,
  S_Form_Field,
  S_Permission_Request,
} from "./protocol/api";
import type { HarnessMessage } from "../types";
import type { PendingInputState, PendingInputQuestion } from "../../types";
import {
  formatPendingInputWizardQuestion,
  resolvePendingInputAnswer,
  matchApprovalChoiceText,
} from "../../pending-input-normalization";
import { isSettledError, OpenCodeApiError } from "./errors";
export type PendingRequest =
  | { kind: "permission"; value: S_Permission_Request }
  | { kind: "form"; value: S_Form_Info };
export type InputReply =
  | {
      kind: "permission";
      decision: "once" | "always" | "reject";
      message?: string;
    }
  | {
      kind: "form";
      answer: Record<string, string | string[] | number | boolean>;
    }
  | { kind: "cancel"; message: string };
const choices = [
  {
    label: "Allow once",
    decision: "accept" as const,
    responseDecision: "once",
  },
  {
    label: "Always allow",
    decision: "acceptForSession" as const,
    responseDecision: "always",
  },
  { label: "Reject", decision: "decline" as const, responseDecision: "reject" },
];
export class PendingInputCoordinator {
  private requests: PendingRequest[] = [];
  private answers: Record<string, string | string[] | number | boolean> = {};
  private index = 0;
  private busy = false;
  constructor(
    private emit: (e: HarnessMessage) => void,
    private reply: (
      request: PendingRequest,
      reply: InputReply,
    ) => Promise<void>,
  ) {}
  get active(): PendingRequest | undefined {
    return this.requests[0];
  }
  get pending(): boolean {
    return !!this.active;
  }
  add(request: PendingRequest): void {
    if (
      request.value.sessionID === "global" ||
      this.requests.some((r) => r.value.id === request.value.id)
    )
      return;
    this.requests.push(request);
    if (this.requests.length === 1) this.show();
  }
  resolve(id: string): void {
    const active = this.active?.value.id === id;
    this.requests = this.requests.filter((r) => r.value.id !== id);
    if (active) {
      this.answers = {};
      this.index = 0;
      this.emit({ type: "pending_input_resolved", requestId: id });
      this.show();
    }
  }
  reconcile(sessionID: string, requests: PendingRequest[]): void {
    const ids = new Set(requests.map((r) => r.value.id));
    for (const old of [...this.requests])
      if (old.value.sessionID === sessionID && !ids.has(old.value.id))
        this.resolve(old.value.id);
    for (const r of requests) this.add(r);
  }
  clear(): void {
    for (const r of [...this.requests]) this.resolve(r.value.id);
  }
  private fields(form: S_Form_Info): S_Form_Field[] {
    return form.fields.filter(
      (f) =>
        f.type !== "external" &&
        !f.hidden &&
        (!f.when ||
          f.when.every((w) => {
            const a = this.answers[w.key];
            if (a === undefined) return false;
            const equal = Array.isArray(a)
              ? a.includes(String(w.value))
              : a === w.value;
            return w.op === "eq" ? equal : !equal;
          })),
    );
  }
  private question(field: S_Form_Field): PendingInputQuestion {
    const options = "options" in field ? (field.options ?? []) : [];
    return {
      id: field.key,
      header: field.title,
      question: field.description ?? field.title ?? field.key,
      options: options.map((o) => ({
        label: o.label,
        value: o.value,
        description: o.description,
      })),
      multiSelect: field.type === "multiselect",
      allowsFreeText: !("custom" in field) || field.custom !== false,
    };
  }
  private show(): void {
    const r = this.active;
    if (!r) return;
    let state: PendingInputState;
    if (r.kind === "permission")
      state = {
        requestId: r.value.id,
        kind: "approval",
        promptText: `${r.value.action}: ${r.value.resources.join(", ")}`,
        options: choices.map((c) => c.label),
        actions: choices.map((c) => ({ kind: "approval", ...c })),
        allowsFreeText: true,
      };
    else {
      const fields = this.fields(r.value);
      const f = fields[this.index];
      if (!f) return;
      const questions = fields.map((f) => this.question(f));
      const q = questions[this.index];
      state = {
        requestId: r.value.id,
        kind: "question",
        questions,
        activeQuestionIndex: this.index,
        options: q.options.map((o) => o.label),
        allowsFreeText: q.allowsFreeText,
        promptText: formatPendingInputWizardQuestion(
          q,
          this.index,
          questions.length,
        ),
        answers: Object.fromEntries(
          Object.entries(this.answers).map(([k, v]) => [
            k,
            { answers: Array.isArray(v) ? v : [String(v)] },
          ]),
        ),
      };
    }
    this.emit({ type: "pending_input", state });
  }
  async option(
    index: number,
    context?: { requestId?: string; questionId?: string },
  ): Promise<boolean> {
    const r = this.active;
    if (!r || (context?.requestId && r.value.id !== context.requestId))
      return false;
    if (r.kind === "permission")
      return choices[index] ? this.text(choices[index].label) : false;
    const field = this.fields(r.value)[this.index];
    if (!field || (context?.questionId && field.key !== context.questionId))
      return false;
    const q = this.question(field);
    return q.options[index] ? this.text(q.options[index].label) : false;
  }
  async text(text: string): Promise<boolean> {
    const r = this.active;
    if (!r || this.busy) return false;
    this.busy = true;
    try {
      if (r.kind === "permission") {
        const choice = matchApprovalChoiceText(choices, text);
        await this.send(r, {
          kind: "permission",
          decision: (choice?.responseDecision ?? "reject") as
            | "once"
            | "always"
            | "reject",
          ...(!choice ? { message: text } : {}),
        });
        if (!choice || choice.responseDecision === "reject")
          for (const other of [...this.requests])
            if (
              other.kind === "permission" &&
              other.value.sessionID === r.value.sessionID
            )
              this.resolve(other.value.id);
        return true;
      }
      const fields = this.fields(r.value);
      const field = fields[this.index];
      if (!field) return false;
      const parsed = resolvePendingInputAnswer(this.question(field), text);
      if (!parsed.ok) {
        await this.send(r, { kind: "cancel", message: text });
        return true;
      }
      let answer: string | string[] | number | boolean =
        field.type === "multiselect" ? parsed.answers : parsed.answers[0];
      if (field.type === "number" || field.type === "integer") {
        answer = Number(answer);
        if (
          !Number.isFinite(answer) ||
          (field.type === "integer" && !Number.isInteger(answer))
        )
          return false;
      }
      if (field.type === "boolean") {
        if (!/^(true|false)$/i.test(String(answer))) return false;
        answer = String(answer).toLowerCase() === "true";
      }
      this.answers[field.key] = answer;
      if (this.index + 1 < this.fields(r.value).length) {
        this.index++;
        this.show();
        return true;
      }
      await this.send(r, { kind: "form", answer: { ...this.answers } });
      return true;
    } finally {
      this.busy = false;
    }
  }
  private async send(r: PendingRequest, reply: InputReply): Promise<void> {
    try {
      await this.reply(r, reply);
    } catch (e) {
      if (
        e instanceof OpenCodeApiError &&
        e._tag === "FormInvalidAnswerError"
      ) {
        this.show();
        throw e;
      }
      if (!isSettledError(e)) throw e;
    }
    this.resolve(r.value.id);
  }
}
