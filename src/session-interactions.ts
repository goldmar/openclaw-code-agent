import type {
  PersistedSessionInfo,
  SessionActionKind,
  SessionActionToken,
} from "./types";
import type { SessionStore } from "./session-store";

export type NotificationButton = { label: string; callbackData: string };

type ButtonSource = {
  worktreePrUrl?: string;
  isExplicitlyResumable?: boolean;
};

export class SessionInteractionService {
  constructor(
    private readonly store: SessionStore,
    private readonly isGitHubCliAvailable: () => boolean,
  ) {}

  createActionToken(
    sessionId: string,
    kind: SessionActionKind,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): SessionActionToken {
    return this.store.createActionToken(sessionId, kind, {
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      ...options,
    });
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    return this.store.consumeActionToken(tokenId);
  }

  makeActionButton(
    sessionId: string,
    kind: SessionActionKind,
    label: string,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): NotificationButton {
    const token = this.createActionToken(sessionId, kind, { label, ...options });
    return { label, callbackData: token.id };
  }

  getWorktreeDecisionButtons(
    sessionId: string,
    session: Pick<PersistedSessionInfo, "worktreePrUrl"> | ButtonSource | undefined,
  ): NotificationButton[][] {
    if (!session) return [];

    const buttons: NotificationButton[] = [
      this.makeActionButton(sessionId, "worktree-merge", "Merge locally"),
    ];

    if (this.isGitHubCliAvailable()) {
      if (session.worktreePrUrl) {
        buttons.push(this.makeActionButton(sessionId, "worktree-view-pr", "View PR", { targetUrl: session.worktreePrUrl }));
        buttons.push(this.makeActionButton(sessionId, "worktree-update-pr", "Update PR"));
      } else {
        buttons.push(this.makeActionButton(sessionId, "worktree-create-pr", "Create PR"));
      }
    }

    buttons.push(this.makeActionButton(sessionId, "worktree-decide-later", "Decide later"));
    buttons.push(this.makeActionButton(sessionId, "worktree-dismiss", "Dismiss"));
    return [buttons];
  }

  getPlanApprovalButtons(sessionId: string): NotificationButton[][] {
    return [[
      this.makeActionButton(sessionId, "plan-approve", "Approve"),
      this.makeActionButton(sessionId, "plan-request-changes", "Request changes"),
      this.makeActionButton(sessionId, "plan-reject", "Reject"),
    ]];
  }

  getResumeButtons(sessionId: string, session: ButtonSource): NotificationButton[][] {
    const buttons: NotificationButton[] = [];
    if (session.isExplicitlyResumable) {
      buttons.push(this.makeActionButton(sessionId, "session-resume", "Resume"));
    }
    buttons.push(this.makeActionButton(sessionId, "view-output", "View output"));
    return [buttons];
  }

  getQuestionButtons(
    sessionId: string,
    options: Array<{ label: string }>,
  ): NotificationButton[][] | undefined {
    if (options.length === 0) return undefined;
    return [options.map((option, index) => (
      this.makeActionButton(sessionId, "question-answer", option.label, { optionIndex: index })
    ))];
  }
}
