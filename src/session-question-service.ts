import { randomUUID } from "node:crypto";
import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import { createLogger } from "./logger";
import { fenceAgentOutput } from "./untrusted-output";

const log = createLogger("session-question-service");

/** Structured input passed by Claude Code's AskUserQuestion tool. */
export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    options?: Array<{ label: string; preview?: string }>;
    multiSelect?: boolean;
  }>;
}

/**
 * Pending AskUserQuestion state stored per session. A question has no timeout
 * of its own (like Codex and OpenCode questions): it waits until it is
 * answered, superseded, or the session is suspended by the idle timeout, after
 * which an answer resumes the session.
 */
export interface PendingAskUserQuestion {
  resolve: (result: { behavior: "allow"; updatedInput: Record<string, unknown> }) => void;
  reject: (err: Error) => void;
  questions: AskUserQuestionInput["questions"];
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
    context: AskUserQuestionResolutionContext = {},
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }> {
    const typedInput = input as unknown as AskUserQuestionInput;
    const questions = typedInput?.questions ?? [];
    if (questions.length === 0) {
      throw new Error("AskUserQuestion: no questions in input");
    }

    const firstQuestion = questions[0];
    const options = firstQuestion.options ?? [];
    const userMessage = `❓ [${session.name}] ${firstQuestion.question}`;
    // The harness names the request it raised; the session may not show it yet.
    const questionId = context.requestId ? context.questionId : activePendingInputQuestionIdentity(session);
    const requestId = context.requestId
      ?? session.pendingInputState?.requestId
      ?? `legacy:${randomUUID()}`;
    const buttons = this.getQuestionButtons(session.id, options, { requestId, questionId });
    const questionBlock = fenceAgentOutput([
      `Question: ${firstQuestion.question}`,
      ...(options.length > 0 ? [`Options:`, ...options.map((o, i) => `  ${i + 1}. ${o.label}`)] : []),
    ].join("\n"), "question");
    const fallbackWakeText = [
      `[ASK USER QUESTION] Session "${session.name}" has a question requiring user input.`,
      ``,
      questionBlock,
      ``,
      `Send the question to the user and call agent_respond(session="${session.id}", message="<answer>", userInitiated=true) with their answer. Do not answer it yourself.`,
    ].join("\n");

    return new Promise((resolve, reject) => {
      const existing = this.pendingQuestions.get(session.id);
      if (existing) {
        existing.reject(new Error(`AskUserQuestion superseded by a newer question for session "${session.name}".`));
      }

      this.pendingQuestions.set(session.id, {
        resolve,
        reject,
        questions,
        requestId,
        questionId,
      });

      // A harness that names the request has raised it as native pending input
      // too; the session's waiting-for-input notice is then the one prompt the
      // user sees (with the same buttons), so posting here would duplicate it.
      if (context.requestId) return;

      this.dispatchSessionNotification(session, {
        label: "ask-user-question",
        idempotencyKey: `ask-user-question:${session.id}:${requestId}`,
        userMessage,
        notifyUser: "always",
        buttons,
        // A question answered (or superseded) before its buttons went out, for
        // example while their tokens waited to be persisted, is never shown.
        shouldDispatch: () => this.pendingQuestions.get(session.id)?.requestId === requestId,
        wakeMessageOnNotifySuccess: [
          `AskUserQuestion delivered to the user.`,
          `Session: ${session.name} | ID: ${session.id}`,
          questionBlock,
          `Await their selection — do NOT answer this question yourself.`,
        ].join("\n"),
        wakeMessageOnNotifyFailed: fallbackWakeText,
      });
    });
  }

  /**
   * Drop a pending AskUserQuestion that the backend already resolved another
   * way (direct text/option submission). Its promise is left unsettled: the
   * harness raced it against the direct answer and no longer awaits it.
   */
  discardAskUserQuestion(sessionId: string, requestId?: string): boolean {
    const pending = this.pendingQuestions.get(sessionId);
    if (!pending) return false;
    if (requestId && pending.requestId !== requestId) return false;
    this.pendingQuestions.delete(sessionId);
    return true;
  }

  resolveAskUserQuestion(
    sessionId: string,
    optionIndex: number,
    context: AskUserQuestionResolutionContext = {},
  ): boolean {
    const pending = this.pendingQuestions.get(sessionId);
    if (!pending) {
      log.warn(`[SessionQuestionService] resolveAskUserQuestion: no pending question for session "${sessionId}"`);
      return false;
    }
    if (context.requestId && context.requestId !== pending.requestId) {
      log.warn(
        `[SessionQuestionService] resolveAskUserQuestion: stale requestId for session "${sessionId}" (expected "${pending.requestId}", got "${context.requestId}")`,
      );
      return false;
    }
    if (context.questionId && context.questionId !== pending.questionId) {
      log.warn(
        `[SessionQuestionService] resolveAskUserQuestion: stale questionId for session "${sessionId}" (expected "${pending.questionId ?? ""}", got "${context.questionId}")`,
      );
      return false;
    }
    const firstQuestion = pending.questions[0];
    const options = firstQuestion.options ?? [];
    const selectedOption = options[optionIndex];
    if (!selectedOption) {
      log.warn(
        `[SessionQuestionService] resolveAskUserQuestion: invalid option index ${optionIndex} for session "${sessionId}" (${options.length} options available)`,
      );
      return false;
    }

    this.pendingQuestions.delete(sessionId);

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
      pending.reject(new Error("SessionManager disposed before AskUserQuestion resolved."));
    }
    this.pendingQuestions.clear();
  }
}
