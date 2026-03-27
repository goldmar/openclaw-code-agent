import type {
  PersistedSessionInfo,
  SessionActionKind,
  SessionActionToken,
} from "./types";
import type { SessionActionTokenStore } from "./session-action-token-store";

export type NotificationButton = { label: string; callbackData: string };

type ButtonSource = {
  worktreePrUrl?: string;
  isExplicitlyResumable?: boolean;
  planDecisionVersion?: number;
};

export class SessionInteractionService {
  constructor(
    private readonly actionTokens: SessionActionTokenStore,
    private readonly isGitHubCliAvailable: () => boolean,
  ) {}

  createActionToken(
    sessionId: string,
    kind: SessionActionKind,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): SessionActionToken {
    return this.actionTokens.createActionToken(sessionId, kind, {
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      ...options,
    });
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    return this.actionTokens.consumeActionToken(tokenId);
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

    const rows: NotificationButton[][] = [];
    const primaryRow: NotificationButton[] = [
      this.makeActionButton(sessionId, "worktree-merge", "Merge"),
    ];
    if (this.isGitHubCliAvailable()) {
      if (session.worktreePrUrl) {
        primaryRow.push(this.makeActionButton(sessionId, "worktree-view-pr", "View PR", {
          targetUrl: session.worktreePrUrl,
        }));
        rows.push(primaryRow);
        rows.push([
          this.makeActionButton(sessionId, "worktree-update-pr", "Sync PR"),
          this.makeActionButton(sessionId, "worktree-decide-later", "Later"),
        ]);
      } else {
        primaryRow.push(this.makeActionButton(sessionId, "worktree-create-pr", "Open PR"));
        rows.push(primaryRow);
        rows.push([
          this.makeActionButton(sessionId, "worktree-decide-later", "Later"),
          this.makeActionButton(sessionId, "worktree-dismiss", "Discard"),
        ]);
      }
    } else {
      rows.push([
        ...primaryRow,
        this.makeActionButton(sessionId, "worktree-decide-later", "Later"),
      ]);
      rows.push([this.makeActionButton(sessionId, "worktree-dismiss", "Discard")]);
      return rows;
    }

    if (session.worktreePrUrl) {
      rows.push([this.makeActionButton(sessionId, "worktree-dismiss", "Discard")]);
      return rows;
    }

    return rows;
  }

  getPlanApprovalButtons(sessionId: string, session?: ButtonSource): NotificationButton[][] {
    return [[
      this.makeActionButton(sessionId, "plan-approve", "Approve", {
        planDecisionVersion: session?.planDecisionVersion,
      }),
      this.makeActionButton(sessionId, "plan-request-changes", "Request changes", {
        planDecisionVersion: session?.planDecisionVersion,
      }),
      this.makeActionButton(sessionId, "plan-reject", "Reject", {
        planDecisionVersion: session?.planDecisionVersion,
      }),
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
