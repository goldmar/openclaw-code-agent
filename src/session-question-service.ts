import { randomUUID } from "node:crypto";
import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";

/** Structured input passed by Claude Code's AskUserQuestion tool. */
export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    options?: Array<{ label: string; preview?: string }>;
    multiSelect?: boolean;
  }>;
}

/** Pending AskUserQuestion state stored per session. */
export interface PendingAskUserQuestion {
  resolve: (result: { behavior: "allow"; updatedInput: Record<string, unknown> }) => void;
  reject: (err: Error) => void;
  questions: AskUserQuestionInput["questions"];
  timeoutHandle: ReturnType<typeof setTimeout>;
  requestId: string;
  questionId?: string;
}

export type AskUserQuestionResolutionContext = {
  requestId?: string;
  questionId?: string;
};

type DispatchQuestionNotification = (
  session: Session,
  request: SessionNotificationRequest,
) => void;

function activePendingInputQuestionIdentity(session: Session): string | undefined {
  const state = session.pendingInputState;
  const activeQuestionIndex = state?.activeQuestionIndex ?? 0;
  return state?.questions?.[activeQuestionIndex]?.id
    ?? (state?.activeQuestionIndex != null ? `q${state.activeQuestionIndex}` : undefined);
}

export class SessionQuestionService {
  constructor(
    private readonly pendingQuestions: Map<string, PendingAskUserQuestion>,
    private readonly dispatchSessionNotification: DispatchQuestionNotification,
    private readonly clearWaitingTimestamp: (sessionId: string) => void,
    private readonly getQuestionButtons: (
      sessionId: string,
      options: Array<{ label: string }>,
      context?: AskUserQuestionResolutionContext,
    ) => NotificationButton[][] | undefined,
  ) {}

  async handleAskUserQuestion(
    session: Session,
    input: Record<string, unknown>,
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }> {
    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
    const typedInput = input as unknown as AskUserQuestionInput;
    const questions = typedInput?.questions ?? [];
    if (questions.length === 0) {
      throw new Error("AskUserQuestion: no questions in input");
    }

    const firstQuestion = questions[0];
    const options = firstQuestion.options ?? [];
    const userMessage = `❓ [${session.name}] ${firstQuestion.question}`;
    const questionKey = session.pendingInputState?.requestId
      ?? `${firstQuestion.question}:${options.map((option) => option.label).join("|")}`;
    const questionId = activePendingInputQuestionIdentity(session);
    const requestId = session.pendingInputState?.requestId
      ?? `legacy:${randomUUID()}`;
    const buttons = this.getQuestionButtons(session.id, options, { requestId, questionId });
    const fallbackWakeText = [
      `[ASK USER QUESTION] Session "${session.name}" has a question requiring user input.`,
      ``,
      `Question: ${firstQuestion.question}`,
      ...(options.length > 0 ? [`Options:`, ...options.map((o, i) => `  ${i + 1}. ${o.label}`)] : []),
      ``,
      `Send the question to the user and call agent_respond(session="${session.id}", message="<answer>") with their answer.`,
    ].join("\n");

    return new Promise((resolve, reject) => {
      const existing = this.pendingQuestions.get(session.id);
      if (existing) {
        clearTimeout(existing.timeoutHandle);
        existing.reject(new Error(`AskUserQuestion superseded by a newer question for session "${session.name}".`));
      }

      const timeoutHandle = setTimeout(() => {
        this.pendingQuestions.delete(session.id);
        reject(new Error(`AskUserQuestion timed out after ${TIMEOUT_MS / 1000}s for session "${session.name}"`));
      }, TIMEOUT_MS);
      timeoutHandle.unref?.();

      this.pendingQuestions.set(session.id, {
        resolve,
        reject,
        questions,
        timeoutHandle,
        requestId,
        questionId,
      });

      this.dispatchSessionNotification(session, {
        label: "ask-user-question",
        idempotencyKey: `ask-user-question:${session.id}:${questionKey}`,
        userMessage,
        notifyUser: "always",
        buttons,
        wakeMessageOnNotifySuccess: [
          `AskUserQuestion delivered to the user.`,
          `Session: ${session.name} | ID: ${session.id}`,
          `Question: ${firstQuestion.question}`,
          `Await their selection — do NOT answer this question yourself.`,
        ].join("\n"),
        wakeMessageOnNotifyFailed: fallbackWakeText,
      });
    });
  }

  resolveAskUserQuestion(
    sessionId: string,
    optionIndex: number,
    context: AskUserQuestionResolutionContext = {},
  ): boolean {
    const pending = this.pendingQuestions.get(sessionId);
    if (!pending) {
      console.warn(`[SessionQuestionService] resolveAskUserQuestion: no pending question for session "${sessionId}"`);
      return false;
    }
    if (context.requestId && context.requestId !== pending.requestId) {
      console.warn(
        `[SessionQuestionService] resolveAskUserQuestion: stale requestId for session "${sessionId}" (expected "${pending.requestId}", got "${context.requestId}")`,
      );
      return false;
    }
    if (context.questionId && context.questionId !== pending.questionId) {
      console.warn(
        `[SessionQuestionService] resolveAskUserQuestion: stale questionId for session "${sessionId}" (expected "${pending.questionId ?? ""}", got "${context.questionId}")`,
      );
      return false;
    }
    clearTimeout(pending.timeoutHandle);
    this.pendingQuestions.delete(sessionId);

    const firstQuestion = pending.questions[0];
    const options = firstQuestion.options ?? [];
    const selectedOption = options[optionIndex];
    if (!selectedOption) {
      pending.reject(new Error(`AskUserQuestion: invalid option index ${optionIndex} (${options.length} options available)`));
      return false;
    }

    this.clearWaitingTimestamp(sessionId);
    pending.resolve({
      behavior: "allow",
      updatedInput: {
        questions: pending.questions,
        answers: { [firstQuestion.question]: selectedOption.label },
      },
    });
    return true;
  }

  dispose(): void {
    for (const pending of this.pendingQuestions.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error("SessionManager disposed before AskUserQuestion resolved."));
    }
    this.pendingQuestions.clear();
  }
}
