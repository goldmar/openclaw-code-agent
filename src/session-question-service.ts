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
}

type DispatchQuestionNotification = (
  session: Session,
  request: SessionNotificationRequest,
) => void;

export class SessionQuestionService {
  constructor(
    private readonly pendingQuestions: Map<string, PendingAskUserQuestion>,
    private readonly dispatchSessionNotification: DispatchQuestionNotification,
    private readonly getQuestionButtons: (
      sessionId: string,
      options: Array<{ label: string }>,
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
    const buttons = this.getQuestionButtons(session.id, options);
    const userMessage = `❓ [${session.name}] ${firstQuestion.question}`;
    const fallbackWakeText = [
      `[ASK USER QUESTION] Session "${session.name}" has a question requiring user input.`,
      ``,
      `Question: ${firstQuestion.question}`,
      ...(options.length > 0 ? [`Options:`, ...options.map((o, i) => `  ${i + 1}. ${o.label}`)] : []),
      ``,
      `Send the question to the user and call agent_respond(session="${session.id}", message="<answer>") with their answer.`,
    ].join("\n");

    return new Promise((resolve, reject) => {
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
      });

      this.dispatchSessionNotification(session, {
        label: "ask-user-question",
        userMessage,
        notifyUser: "always",
        buttons,
        wakeMessageOnNotifySuccess:
          `AskUserQuestion buttons delivered to user. Await their selection — do NOT answer this question yourself.`,
        wakeMessageOnNotifyFailed: fallbackWakeText,
      });
    });
  }

  resolveAskUserQuestion(sessionId: string, optionIndex: number): void {
    const pending = this.pendingQuestions.get(sessionId);
    if (!pending) {
      console.warn(`[SessionQuestionService] resolveAskUserQuestion: no pending question for session "${sessionId}"`);
      return;
    }
    clearTimeout(pending.timeoutHandle);
    this.pendingQuestions.delete(sessionId);

    const firstQuestion = pending.questions[0];
    const options = firstQuestion.options ?? [];
    const selectedOption = options[optionIndex];
    if (!selectedOption) {
      pending.reject(new Error(`AskUserQuestion: invalid option index ${optionIndex} (${options.length} options available)`));
      return;
    }

    pending.resolve({
      behavior: "allow",
      updatedInput: {
        questions: pending.questions,
        answers: { [firstQuestion.question]: selectedOption.label },
      },
    });
  }

  dispose(): void {
    for (const pending of this.pendingQuestions.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error("SessionManager disposed before AskUserQuestion resolved."));
    }
    this.pendingQuestions.clear();
  }
}
