import type {
  PersistedSessionInfo,
  PermissionMode,
  PlanApprovalMode,
  ReasoningEffort,
  SessionRoute,
  SessionActionKind,
  SessionActionToken,
  WorktreeStrategy,
} from "./types";
import type { SessionActionTokenStore } from "./session-action-token-store";
import { logButtonDiagnostic, summarizeButtons } from "./button-diagnostics";
import { getRepoPolicyOptionsForPrAvailability } from "./repo-policy";

export type NotificationButton = {
  label: string;
  callbackData: string;
  style?: "primary" | "secondary" | "success" | "danger";
};

type ButtonSource = {
  worktreePrUrl?: string;
  isExplicitlyResumable?: boolean;
  planDecisionVersion?: number;
  actionablePlanDecisionVersion?: number;
};

const QUESTION_BUTTON_LABEL_MAX_LENGTH = 36;
const QUESTION_BUTTONS_PER_ROW = 2;
const QUESTION_BUTTON_LABEL_ELLIPSIS = "...";

function shortenQuestionButtonLabel(label: string): string {
  const codePoints = Array.from(label);
  if (codePoints.length <= QUESTION_BUTTON_LABEL_MAX_LENGTH) return label;
  return `${codePoints.slice(0, QUESTION_BUTTON_LABEL_MAX_LENGTH - QUESTION_BUTTON_LABEL_ELLIPSIS.length).join("")}${QUESTION_BUTTON_LABEL_ELLIPSIS}`;
}

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

  getActionToken(tokenId: string): SessionActionToken | undefined {
    return this.actionTokens.getActionToken(tokenId);
  }

  listActiveActionTokens(kind?: SessionActionKind): SessionActionToken[] {
    return this.actionTokens.listActiveActionTokens(kind);
  }

  clearRepoPolicyChoiceTokens(sessionId: string): void {
    this.actionTokens.deleteActionTokensForSessionByKind(sessionId, "repo-policy-set");
  }

  clearPlanDecisionTokens(sessionId: string, keepVersion?: number): void {
    this.actionTokens.deletePlanDecisionTokensForSession(sessionId, keepVersion);
  }

  makeActionButton(
    sessionId: string,
    kind: SessionActionKind,
    label: string,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): NotificationButton {
    const token = this.createActionToken(sessionId, kind, { label, ...options });
    return {
      label,
      callbackData: token.id,
      style: this.resolveButtonStyle(kind),
    };
  }

  private resolveButtonStyle(kind: SessionActionKind): NotificationButton["style"] {
    switch (kind) {
      case "plan-approve":
      case "worktree-create-pr":
      case "worktree-update-pr":
      case "plan-offer-start":
      case "repo-policy-set":
        return "primary";
      case "worktree-merge":
      case "session-resume":
      case "session-restart":
      case "plugin-update-install":
      case "plugin-update-restart":
        return "success";
      case "plugin-update-remind-later":
        return "secondary";
      case "plan-reject":
      case "worktree-dismiss":
      case "plugin-update-dismiss":
        return "danger";
      default:
        return "secondary";
    }
  }

  getWorktreeDecisionButtons(
    sessionId: string,
    session: Pick<PersistedSessionInfo, "worktreePrUrl"> | ButtonSource | undefined,
    allowedActions: { merge: boolean; pr: boolean } = { merge: true, pr: true },
  ): NotificationButton[][] {
    if (!session) return [];

    const rows: NotificationButton[][] = [];
    const primaryRow: NotificationButton[] = [];
    if (allowedActions.merge) {
      primaryRow.push(this.makeActionButton(sessionId, "worktree-merge", "Merge"));
    }
    if (allowedActions.pr && this.isGitHubCliAvailable()) {
      if (session.worktreePrUrl) {
        primaryRow.push(this.makeActionButton(sessionId, "worktree-view-pr", "View PR", {
          targetUrl: session.worktreePrUrl,
        }));
        if (primaryRow.length > 0) rows.push(primaryRow);
        rows.push([
          this.makeActionButton(sessionId, "worktree-update-pr", "Sync PR"),
          this.makeActionButton(sessionId, "worktree-decide-later", "Later"),
        ]);
      } else {
        primaryRow.push(this.makeActionButton(sessionId, "worktree-create-pr", "Open PR"));
        if (primaryRow.length > 0) rows.push(primaryRow);
        rows.push([
          this.makeActionButton(sessionId, "worktree-decide-later", "Later"),
          this.makeActionButton(sessionId, "worktree-dismiss", "Discard"),
        ]);
      }
    } else {
      rows.push([...primaryRow, this.makeActionButton(sessionId, "worktree-decide-later", "Later")]);
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
    const planDecisionVersion = session?.actionablePlanDecisionVersion ?? session?.planDecisionVersion;
    this.clearPlanDecisionTokens(sessionId, planDecisionVersion);
    const buttons = [[
      this.makeActionButton(sessionId, "plan-approve", "Approve", {
        planDecisionVersion,
      }),
      this.makeActionButton(sessionId, "plan-request-changes", "Revise", {
        planDecisionVersion,
      }),
      this.makeActionButton(sessionId, "plan-reject", "Reject", {
        planDecisionVersion,
      }),
    ]];
    logButtonDiagnostic("plan_approval_buttons_created", {
      sessionId,
      planDecisionVersion,
      ...summarizeButtons(buttons),
    });
    return buttons;
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
    context: { requestId?: string; questionId?: string } = {},
  ): NotificationButton[][] | undefined {
    if (options.length === 0) return undefined;
    const buttons = options.map((option, index) => {
      const token = this.createActionToken(sessionId, "question-answer", {
        label: option.label,
        optionIndex: index,
        pendingInputRequestId: context.requestId,
        pendingInputQuestionId: context.questionId,
      });
      return {
        label: shortenQuestionButtonLabel(option.label),
        callbackData: token.id,
        style: this.resolveButtonStyle("question-answer"),
      };
    });
    const rows: NotificationButton[][] = [];
    for (let index = 0; index < buttons.length; index += QUESTION_BUTTONS_PER_ROW) {
      rows.push(buttons.slice(index, index + QUESTION_BUTTONS_PER_ROW));
    }
    return rows;
  }

  getPlanOfferButtons(args: {
    offerId: string;
    route: SessionRoute;
    planName: string;
    planPrompt: string;
    planWorkdir: string;
    planWorktreeStrategy?: WorktreeStrategy;
  }): NotificationButton[][] {
    const { offerId, route, planName, planPrompt, planWorkdir, planWorktreeStrategy } = args;
    const buttons = [[
      this.makeActionButton(offerId, "plan-offer-start", "Start Plan", {
        route,
        launchName: planName,
        launchPrompt: planPrompt,
        launchWorkdir: planWorkdir,
        launchWorktreeStrategy: planWorktreeStrategy,
      }),
      this.makeActionButton(offerId, "plan-offer-dismiss", "Dismiss", { route }),
    ]];
    logButtonDiagnostic("plan_offer_buttons_created", {
      offerId,
      planName,
      channel: route.provider,
      target: route.target,
      accountId: route.accountId,
      threadId: route.threadId,
      sessionKey: route.sessionKey,
      planPromptLength: planPrompt.length,
      planWorkdirLength: planWorkdir.length,
      planWorktreeStrategy,
      ...summarizeButtons(buttons),
    });
    return buttons;
  }

  getRepoPolicyChoiceButtons(args: {
    choiceId: string;
    route: SessionRoute;
    repoRoot: string;
    launchPrompt: string;
    launchWorkdir: string;
    launchName?: string;
    launchModel?: string;
    launchReasoningEffort?: ReasoningEffort;
    launchFastMode?: boolean;
    launchSystemPrompt?: string;
    launchAllowedTools?: string[];
    launchResumeSessionId?: string;
    launchResumedFromSessionName?: string;
    launchResumeWorktreeFrom?: string;
    launchSessionIdOverride?: string;
    launchClearedPersistedCodexResume?: boolean;
    launchForkSession?: boolean;
    launchForceNewSession?: boolean;
    launchPermissionMode?: PermissionMode;
    launchPlanApproval?: PlanApprovalMode;
    launchHarness?: string;
    launchWorktreeStrategy?: WorktreeStrategy;
    launchWorktreeBaseBranch?: string;
    launchWorktreePrTargetRepo?: string;
    launchOriginAgentId?: string;
    prAvailable?: boolean;
  }): NotificationButton[][] {
    const options = getRepoPolicyOptionsForPrAvailability(args.prAvailable ?? true);
    const rows = Array.from({ length: Math.ceil(options.length / 2) }, (_, index) => options.slice(index * 2, index * 2 + 2))
      .map((rowOptions) => rowOptions.map((option) => (
      this.makeActionButton(args.choiceId, "repo-policy-set", option.label, {
        route: args.route,
        repoPolicy: option.policy,
        repoPolicyWorkdir: args.repoRoot,
        launchName: args.launchName,
        launchPrompt: args.launchPrompt,
        launchWorkdir: args.launchWorkdir,
        launchModel: args.launchModel,
        launchReasoningEffort: args.launchReasoningEffort,
        launchFastMode: args.launchFastMode,
        launchSystemPrompt: args.launchSystemPrompt,
        launchAllowedTools: args.launchAllowedTools,
        launchResumeSessionId: args.launchResumeSessionId,
        launchResumedFromSessionName: args.launchResumedFromSessionName,
        launchResumeWorktreeFrom: args.launchResumeWorktreeFrom,
        launchSessionIdOverride: args.launchSessionIdOverride,
        launchClearedPersistedCodexResume: args.launchClearedPersistedCodexResume,
        launchForkSession: args.launchForkSession,
        launchForceNewSession: args.launchForceNewSession,
        launchPermissionMode: args.launchPermissionMode,
        launchPlanApproval: args.launchPlanApproval,
        launchHarness: args.launchHarness,
        launchWorktreeStrategy: args.launchWorktreeStrategy,
        launchWorktreeBaseBranch: args.launchWorktreeBaseBranch,
        launchWorktreePrTargetRepo: args.launchWorktreePrTargetRepo,
        launchOriginAgentId: args.launchOriginAgentId,
      })
    )));
    logButtonDiagnostic("repo_policy_choice_buttons_created", {
      choiceId: args.choiceId,
      repoRoot: args.repoRoot,
      channel: args.route.provider,
      target: args.route.target,
      accountId: args.route.accountId,
      threadId: args.route.threadId,
      sessionKey: args.route.sessionKey,
      labels: options.map((option) => option.label),
      ...summarizeButtons(rows),
    });
    return rows;
  }

}
