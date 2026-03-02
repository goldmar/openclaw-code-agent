import { execFile } from "child_process";
import { writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { Session } from "./session";
import { pluginConfig } from "./config";
import { formatDuration, generateSessionName, lastCompleteLines, truncateText } from "./format";
import type { NotificationService } from "./notifications";
import type { SessionConfig, SessionStatus, SessionMetrics, PersistedSessionInfo, KillReason } from "./types";

const LOBSTER_WORKFLOW_PATH = resolve(__dirname, "..", "workflows", "plan-approval.lobster");

const CLEANUP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const KILLABLE_STATUSES = new Set<SessionStatus>(["starting", "running"]);
const WAITING_EVENT_DEBOUNCE_MS = 5_000;
const WAKE_CLI_TIMEOUT_MS = 30_000;
const WAKE_RETRY_DELAY_MS = 5_000;

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  maxSessions: number;
  maxPersistedSessions: number;
  notifications: NotificationService | null = null;

  private lastWaitingEventTimestamps: Map<string, number> = new Map();
  private pendingRetryTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  // Single-index persistence: keyed by harnessSessionId
  private persisted: Map<string, PersistedSessionInfo> = new Map();
  private idIndex: Map<string, string> = new Map();     // sessionId → harnessSessionId
  private nameIndex: Map<string, string> = new Map();   // name → harnessSessionId

  private _metrics: SessionMetrics = {
    totalCostUsd: 0,
    costPerDay: new Map(),
    sessionsByStatus: { completed: 0, failed: 0, killed: 0 },
    totalLaunched: 0,
    totalDurationMs: 0,
    sessionsWithDuration: 0,
    mostExpensive: null,
  };

  constructor(maxSessions: number = 5, maxPersistedSessions: number = 50) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
  }

  private uniqueName(baseName: string): string {
    const activeNames = new Set(
      [...this.sessions.values()]
        .filter((s) => KILLABLE_STATUSES.has(s.status))
        .map((s) => s.name),
    );
    if (!activeNames.has(baseName)) return baseName;
    let i = 2;
    while (activeNames.has(`${baseName}-${i}`)) i++;
    return `${baseName}-${i}`;
  }

  spawn(config: SessionConfig): Session {
    const activeCount = [...this.sessions.values()].filter(
      (s) => KILLABLE_STATUSES.has(s.status),
    ).length;
    if (activeCount >= this.maxSessions) {
      throw new Error(`Max sessions reached (${this.maxSessions}). Use agent_sessions to list active sessions and agent_kill to end one.`);
    }

    const baseName = config.name || generateSessionName(config.prompt);
    const name = this.uniqueName(baseName);
    if (name !== baseName) {
      console.warn(`[SessionManager] Name conflict: "${baseName}" → "${name}" (active session with same name exists)`);
    }
    const session = new Session(config, name);
    this.sessions.set(session.id, session);
    this._metrics.totalLaunched++;

    if (this.notifications) {
      this.notifications.attachToSession(session);
    }

    // Wire event handlers for lifecycle management
    session.on("statusChange", (_s: Session, newStatus: SessionStatus) => {
      if (TERMINAL_STATUSES.has(newStatus)) {
        this.onSessionTerminal(session);
      }
    });

    session.on("turnEnd", (_s: Session, hadQuestion: boolean) => {
      if (hadQuestion) {
        this.triggerWaitingForInputEvent(session);
      } else {
        this.triggerTurnCompleteEvent(session);
      }
    });

    session.start();

    // Send launch notification
    if (this.notifications) {
      const launchText = `🚀 [${session.name}] Launched | ${session.workdir} | ${session.model ?? "default"}`;
      this.deliverToTelegram(session, launchText);
    }

    return session;
  }

  private onSessionTerminal(session: Session): void {
    this.persistSession(session);

    if (session.status === "completed") {
      this.triggerAgentEvent(session);
    } else {
      // Failed or killed — informational Telegram notification
      const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
      const duration = formatDuration(session.duration);

      let statusLabel: string;
      let errorSummary: string | undefined;

      if (session.status === "failed") {
        statusLabel = "Failed";
        const rawError = session.error
          || (session.result?.is_error && session.result.result)
          || (session.result?.result)
          || this.extractLastOutputLine(session)
          || `Session failed with no error details (session=${session.id}, subtype=${session.result?.subtype ?? "none"}, turns=${session.result?.num_turns ?? 0})`;
        errorSummary = truncateText(rawError, 200);
      } else {
        const reasonMap: Record<string, string> = {
          "user": "by agent/user",
          "idle-timeout": `idle ${pluginConfig.idleTimeoutMinutes ?? 30}min`,
          "unknown": "",
        };
        const killDetail = reasonMap[session.killReason] || "";
        statusLabel = `Killed${killDetail ? ` (${killDetail})` : ""}`;
      }

      const icon = session.status === "failed" ? "❌" : "⛔";
      const notificationText = [
        `${icon} [${session.name}] ${statusLabel} | ${costStr} | ${duration}`,
        ...(errorSummary ? [`   ⚠️ ${errorSummary}`] : []),
      ].join("\n");

      this.deliverToTelegram(session, notificationText);
    }

    this.lastWaitingEventTimestamps.delete(session.id);
  }

  private persistSession(session: Session): void {
    // Record metrics once
    const alreadyPersisted = this.idIndex.has(session.id);
    if (!alreadyPersisted) {
      this.recordSessionMetrics(session);
    }

    if (!session.harnessSessionId) return;

    let outputPath: string | undefined;
    try {
      const outputFile = join(tmpdir(), `openclaw-agent-${session.id}.txt`);
      const fullOutput = session.getOutput().join("\n");
      if (fullOutput.length > 0) {
        writeFileSync(outputFile, fullOutput, "utf-8");
        outputPath = outputFile;
      }
    } catch (err: any) {
      console.warn(`[SessionManager] Failed to write output file for session ${session.id}: ${err.message}`);
    }

    const info: PersistedSessionInfo = {
      harnessSessionId: session.harnessSessionId,
      name: session.name,
      prompt: session.prompt,
      workdir: session.workdir,
      model: session.model,
      completedAt: session.completedAt,
      status: session.status,
      costUsd: session.costUsd,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      outputPath,
    };

    this.persisted.set(session.harnessSessionId, info);
    this.idIndex.set(session.id, session.harnessSessionId);
    this.nameIndex.set(session.name, session.harnessSessionId);
  }

  private recordSessionMetrics(session: Session): void {
    const cost = session.costUsd ?? 0;
    const status = session.status;

    this._metrics.totalCostUsd += cost;

    const dateKey = new Date(session.completedAt ?? session.startedAt).toISOString().slice(0, 10);
    this._metrics.costPerDay.set(dateKey, (this._metrics.costPerDay.get(dateKey) ?? 0) + cost);

    if (TERMINAL_STATUSES.has(status)) {
      this._metrics.sessionsByStatus[status as "completed" | "failed" | "killed"]++;
    }

    if (session.completedAt) {
      const durationMs = session.completedAt - session.startedAt;
      this._metrics.totalDurationMs += durationMs;
      this._metrics.sessionsWithDuration++;
    }

    if (!this._metrics.mostExpensive || cost > this._metrics.mostExpensive.costUsd) {
      this._metrics.mostExpensive = {
        id: session.id,
        name: session.name,
        costUsd: cost,
        prompt: truncateText(session.prompt, 80),
      };
    }
  }

  getMetrics(): SessionMetrics { return this._metrics; }

  // -- Wake / notification delivery --

  private buildDeliverArgs(originChannel?: string, threadId?: string | number): string[] {
    if (!originChannel || originChannel === "unknown" || originChannel === "gateway") return [];
    const parts = originChannel.split("|");
    if (parts.length < 2) return [];
    const args: string[] = [];
    const topicSuffix = (threadId != null && parts[0] === "telegram") ? `:topic:${threadId}` : "";
    if (parts.length >= 3) {
      args.push("--deliver", "--reply-channel", parts[0], "--reply-account", parts[1], "--reply-to", parts.slice(2).join("|") + topicSuffix);
    } else {
      args.push("--deliver", "--reply-channel", parts[0], "--reply-to", parts[1] + topicSuffix);
    }
    return args;
  }

  /**
   * Look up the OpenClaw session UUID for a given session key from the sessions.json store.
   * Returns undefined if the key is not found or the store can't be read.
   */
  private resolveOriginSessionId(agentId: string, sessionKey?: string): string | undefined {
    if (!sessionKey) return undefined;
    try {
      const storePath = join(homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
      const raw = readFileSync(storePath, "utf-8");
      const store = JSON.parse(raw);
      const entry = store[sessionKey];
      if (entry?.sessionId) return entry.sessionId;
      console.warn(`[SessionManager] resolveOriginSessionId: key=${sessionKey} not found in ${storePath} (${Object.keys(store).length} keys in store)`);
    } catch (err: any) {
      console.warn(`[SessionManager] resolveOriginSessionId: error reading sessions store for agent=${agentId}: ${err.message}`);
    }
    return undefined;
  }

  private wakeAgent(session: Session, eventText: string, telegramText: string, label: string): void {
    const agentId = session.originAgentId?.trim();

    if (!agentId) {
      this.deliverToTelegram(session, telegramText);
      this.fireSystemEventWithRetry(eventText, label, session.id);
      return;
    }

    // Agent handles — skip system Telegram to prevent duplicates.
    // Exception: always send Telegram for plan-approval events so the user
    // gets a direct notification even if the parent agent doesn't relay it.
    if (label === "plan-approval") {
      this.deliverToTelegram(session, telegramText);
    }

    // --reply-to with :topic: ensures agent response goes to correct topic.
    const deliverArgs = this.buildDeliverArgs(session.originChannel, session.originThreadId);

    // Route to the originating session (e.g. topic-28) instead of the default agent session.
    //
    // Route wake event to the originating session using --session-id with the session key.
    // Passing the session key string directly as --session-id correctly targets the
    // originating chat session (e.g. agent:main:telegram:group:-1003863755361:topic:28).
    let args: string[];
    if (session.originSessionKey) {
      args = ["agent", "--agent", agentId, "--session-id", session.originSessionKey, "--message", eventText, ...deliverArgs];
    } else {
      args = ["agent", "--agent", agentId, "--message", eventText, ...deliverArgs];
      console.warn(`[SessionManager] No originSessionKey on session=${session.id} — wake will route to agent ${agentId} default session`);
    }

    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err) => {
      if (err) {
        console.error(`[SessionManager] Agent wake failed for ${label} session=${session.id}, agent=${agentId}: ${err.message}`);
        const timer = setTimeout(() => {
          this.pendingRetryTimers.delete(timer);
          execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (retryErr) => {
            if (retryErr) {
              console.error(`[SessionManager] Agent wake retry also failed for ${label} session=${session.id}, agent=${agentId}`);
              // Last resort: send system Telegram so user isn't left in the dark
              this.deliverToTelegram(session, telegramText);
            }
          });
        }, WAKE_RETRY_DELAY_MS);
        this.pendingRetryTimers.add(timer);
      }
    });
  }

  deliverToTelegram(session: Session, text: string): void {
    if (!this.notifications) return;
    this.notifications.emitToChannel(session.originChannel || "unknown", text, session.originThreadId);
  }

  /**
   * Run the Lobster plan-approval workflow as a structural gate.
   * Sends a direct Telegram notification with the plan summary and a resume token,
   * bypassing the orchestrator entirely. The user approves/rejects via Lobster's
   * approval mechanism which then calls agent_respond on the session.
   */
  private runLobsterApproval(session: Session, planSummary: string): void {
    const argsJson = JSON.stringify({
      session_id: session.id,
      session_name: session.name,
      plan_summary: planSummary,
    });

    const args = [
      "invoke", "--tool", "lobster",
      "--args-json", JSON.stringify({
        action: "run",
        pipeline: LOBSTER_WORKFLOW_PATH,
        argsJson,
        timeoutMs: 0, // No timeout — waits for human approval
      }),
    ];

    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        console.error(`[SessionManager] Lobster launch failed for session=${session.id}: ${err.message}`);
        // Fallback: send Telegram directly so the user isn't left in the dark
        this.deliverToTelegram(session, `📋 [${session.name}] Plan ready — Lobster gate failed, please review manually:\n\n${truncateText(planSummary, 800)}`);
        return;
      }

      // Parse the Lobster response to get the resume token
      let resumeToken: string | undefined;
      try {
        const response = JSON.parse(stdout.trim());
        resumeToken = response?.requiresApproval?.resumeToken
          ?? response?.details?.requiresApproval?.resumeToken;
      } catch {
        console.warn(`[SessionManager] Could not parse Lobster response for session=${session.id}: ${stdout?.substring(0, 200)}`);
      }

      // Store token on session for programmatic resume via agent_respond
      if (resumeToken) {
        session.lobsterResumeToken = resumeToken;
      }

      // Send Telegram notification with plan summary
      const telegramLines = [
        `📋 [${session.name}] Plan ready for approval`,
        ``,
        truncateText(planSummary, 1200),
        ``,
        `Session: ${session.name} (${session.id})`,
        ``,
        `To approve: reply "approve"`,
        `To reject: reply with feedback`,
      ];
      this.deliverToTelegram(session, telegramLines.join("\n"));
    });
  }

  /**
   * Resume (or cancel) a Lobster approval workflow by token.
   * Calls `openclaw invoke --tool lobster` with the resume action.
   */
  resumeLobsterApproval(token: string, approve: boolean): Promise<void> {
    const timeoutMs = approve ? 30_000 : 10_000;
    return new Promise<void>((resolve, reject) => {
      const args = [
        "invoke", "--tool", "lobster",
        "--args-json", JSON.stringify({ action: "resume", token, approve }),
      ];
      execFile("openclaw", args, { timeout: timeoutMs }, (err) => {
        if (err) {
          console.error(`[SessionManager] Lobster resume failed (approve=${approve}): ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /** Returns true if the event should proceed; false if debounced. */
  private debounceWaitingEvent(sessionId: string): boolean {
    const now = Date.now();
    const lastTs = this.lastWaitingEventTimestamps.get(sessionId);
    if (lastTs && now - lastTs < WAITING_EVENT_DEBOUNCE_MS) return false;
    this.lastWaitingEventTimestamps.set(sessionId, now);
    return true;
  }

  private fireSystemEventWithRetry(eventText: string, label: string, sessionId: string): void {
    const args = ["system", "event", "--text", eventText, "--mode", "now"];
    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err) => {
      if (err) {
        console.error(`[SessionManager] System event failed for ${label} session=${sessionId}: ${err.message}`);
        const timer = setTimeout(() => {
          this.pendingRetryTimers.delete(timer);
          execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (retryErr) => {
            if (retryErr) console.error(`[SessionManager] System event retry also failed for ${label} session=${sessionId}`);
          });
        }, WAKE_RETRY_DELAY_MS);
        this.pendingRetryTimers.add(timer);
      }
    });
  }

  private originThreadLine(session: Session): string {
    return session.originThreadId != null
      ? `Session origin thread: ${session.originThreadId}`
      : "";
  }

  private extractLastOutputLine(session: Session): string | undefined {
    const lines = session.getOutput(3);
    const last = lines.filter(l => l.trim()).pop()?.trim();
    return last || undefined;
  }

  private getOutputPreview(session: Session, maxChars: number = 1000): string {
    const raw = session.getOutput(20).join("\n");
    return raw.length > maxChars ? lastCompleteLines(raw, maxChars) : raw;
  }

  private triggerAgentEvent(session: Session): void {
    const preview = this.getOutputPreview(session);

    const eventText = [
      `Coding agent session completed.`,
      `Name: ${session.name} | ID: ${session.id}`,
      `Status: ${session.status}`,
      this.originThreadLine(session),
      ``,
      `Output preview:`,
      preview,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session completion:`,
      `1. Use agent_output(session='${session.id}', full=true) to read the full result.`,
      `2. If this is part of a multi-phase pipeline, launch the next phase NOW — do not wait for user input.`,
      `3. Notify the user with a summary of what was done.`,
    ].join("\n");

    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = formatDuration(session.duration);
    const telegramText = `✅ [${session.name}] Completed | ${costStr} | ${duration}`;

    this.wakeAgent(session, eventText, telegramText, "completed");
  }

  private triggerWaitingForInputEvent(session: Session): void {
    if (!this.debounceWaitingEvent(session.id)) return;

    const preview = this.getOutputPreview(session);
    const isPlanApproval = session.pendingPlanApproval;

    const telegramText = isPlanApproval
      ? `📋 [${session.name}] Plan ready for review:\n\n${preview}\n\nReply to approve or provide feedback.`
      : `🔔 [${session.name}] Waiting for input`;

    let eventText: string;
    if (isPlanApproval) {
      const planApprovalMode = pluginConfig.planApproval ?? "delegate";
      if (planApprovalMode === "ask") {
        // ASK mode: bypass the orchestrator entirely. Use Lobster's approval: required
        // to create a hard structural gate. Send the user a direct Telegram
        // notification with the plan summary. On approve/reject, Lobster
        // calls agent_respond on the session directly.
        this.runLobsterApproval(session, preview);
        return; // Do NOT wake the orchestrator — Lobster handles the full flow
      } else if (planApprovalMode === "delegate") {
        eventText = [
          `[DELEGATED PLAN APPROVAL] Coding agent session has finished its plan and is requesting approval to implement.`,
          `Name: ${session.name} | ID: ${session.id}`,
          this.originThreadLine(session),
          `Permission mode: plan → will switch to bypassPermissions on approval`,
          ``,
          `⚠️ YOU MUST COMPLETE THESE STEPS IN ORDER. Do NOT skip any step.`,
          ``,
          `━━━ STEP 1 (MANDATORY): Read the full plan ━━━`,
          `Call agent_output(session='${session.id}', full=true) to read the FULL plan output.`,
          `The preview below is truncated — you MUST read the full output before making any decision.`,
          ``,
          `Preview (truncated):`,
          preview,
          ``,
          `━━━ STEP 2 (MANDATORY): Notify the user ━━━`,
          `After reading the full plan, use the message tool to send the user a summary that includes:`,
          `- What files/components will be changed`,
          `- Risk level (low/medium/high) and why`,
          `- Scope: does this match the original task or has it expanded?`,
          `- Any concerns or assumptions the plan makes`,
          `This message creates accountability — you cannot approve blindly.`,
          ``,
          `━━━ STEP 3 (ONLY AFTER steps 1 and 2): Decide ━━━`,
          `You are the delegated decision-maker. Choose ONE:`,
          ``,
          `APPROVE the plan directly if ALL of the following are true:`,
          `- You have read the FULL plan (not just the preview)`,
          `- You have sent the user the summary message`,
          `- The plan scope matches the original task request`,
          `- The changes are low-risk (no destructive operations, no credential handling, no production deployments)`,
          `- The plan is clear and well-scoped (no ambiguous requirements or open design questions)`,
          `- No architectural decisions that the user should weigh in on`,
          `- The working directory and codebase are correct`,
          ``,
          `ESCALATE to the user and WAIT if ANY of the following are true:`,
          `- The plan involves destructive operations (deleting files, dropping tables, force-pushing)`,
          `- The plan involves credentials, secrets, or production environments`,
          `- The plan requires architectural decisions not covered by the original task`,
          `- The scope has expanded beyond the original request`,
          `- The requirements are ambiguous or the plan makes assumptions the user should confirm`,
          `- You are unsure — when in doubt, always escalate`,
          ``,
          `If approving: agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
          `If escalating: tell the user you need their decision and WAIT for his explicit response.`,
          `To request changes: agent_respond(session='${session.id}', message='<your feedback>') — do NOT set approve=true. The agent will revise the plan.`,
        ].join("\n");
      } else {
        // approve mode — always auto-approve
        eventText = [
          `[AUTO-APPROVE] Session has a plan ready. Approve it now:`,
          `agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
        ].join("\n");
      }
    } else {
      const sessionType = session.multiTurn ? "Multi-turn session" : "Session";
      eventText = [
        `[SYSTEM INSTRUCTION: Follow your auto-respond rules strictly. If this is a permission request or "should I continue?" → auto-respond. For ALL other questions → forward the agent's EXACT question to the user. Do NOT add your own analysis, commentary, or interpretation. Do NOT "nudge" or "poke" the session.]`,
        ``,
        `${sessionType} is waiting for input.`,
        `Name: ${session.name} | ID: ${session.id}`,
        this.originThreadLine(session),
        ``,
        `Last output:`,
        preview,
        ``,
        `Use agent_respond(session='${session.id}', message='...') to send a reply, or agent_output(session='${session.id}', full: true) to see full context before deciding.`,
      ].join("\n");
    }

    this.wakeAgent(session, eventText, telegramText, isPlanApproval ? "plan-approval" : "waiting");
  }

  private triggerTurnCompleteEvent(session: Session): void {
    if (!this.debounceWaitingEvent(session.id)) return;

    const preview = this.getOutputPreview(session);
    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const telegramText = `🔄 [${session.name}] Turn done | ${costStr}`;

    const postTurnMin = pluginConfig.postTurnIdleMinutes ?? 5;
    const eventText = [
      `Coding agent session finished its current turn (session is still running).`,
      `Name: ${session.name} | ID: ${session.id}`,
      this.originThreadLine(session),
      `Status: running (multi-turn, awaiting follow-up or user review)`,
      ``,
      `Output preview:`,
      preview,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session completion:`,
      `1. Use agent_output(session='${session.id}', full=true) to read the full output.`,
      `2. If this is part of a multi-phase pipeline, launch the next phase NOW — do not wait for user input.`,
      `3. Notify the user with a summary of what was done.`,
      `4. If the output appears to ask a question or request approval, forward it to the user.`,
      `The session is still running — use agent_respond(session='${session.id}', message='...') if you need to send a follow-up.`,
      `The session will auto-complete in ${postTurnMin} minutes if no follow-up arrives (auto-resumes on next message).`,
    ].join("\n");

    this.wakeAgent(session, eventText, telegramText, "turn-complete");
  }

  // -- Public API --

  resolve(idOrName: string): Session | undefined {
    const byId = this.sessions.get(idOrName);
    if (byId) return byId;
    for (const session of this.sessions.values()) {
      if (session.name === idOrName) return session;
    }
    return undefined;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(filter?: SessionStatus | "all"): Session[] {
    let result = [...this.sessions.values()];
    if (filter && filter !== "all") {
      result = result.filter((s) => s.status === filter);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }

  kill(id: string, reason?: KillReason): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill(reason ?? "user");
    return true;
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      if (KILLABLE_STATUSES.has(session.status)) {
        this.kill(session.id);
      }
    }
    for (const timer of this.pendingRetryTimers) clearTimeout(timer);
    this.pendingRetryTimers.clear();
  }

  resolveHarnessSessionId(ref: string): string | undefined {
    const active = this.resolve(ref);
    if (active?.harnessSessionId) return active.harnessSessionId;

    // Check indexes
    const byId = this.idIndex.get(ref);
    if (byId && this.persisted.has(byId)) return byId;
    const byName = this.nameIndex.get(ref);
    if (byName && this.persisted.has(byName)) return byName;
    // Direct harnessSessionId lookup
    if (this.persisted.has(ref)) return ref;

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
    return undefined;
  }

  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    // Direct harnessSessionId
    const direct = this.persisted.get(ref);
    if (direct) return direct;
    // By internal id
    const byId = this.idIndex.get(ref);
    if (byId) return this.persisted.get(byId);
    // By name
    const byName = this.nameIndex.get(ref);
    if (byName) return this.persisted.get(byName);
    return undefined;
  }

  listPersistedSessions(): PersistedSessionInfo[] {
    return [...this.persisted.values()].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (
        session.completedAt &&
        TERMINAL_STATUSES.has(session.status) &&
        now - session.completedAt > CLEANUP_MAX_AGE_MS
      ) {
        this.persistSession(session);
        this.sessions.delete(id);
        this.lastWaitingEventTimestamps.delete(id);
      }
    }

    // Clean old /tmp output files (24h)
    try {
      const TMP_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
      const tmpDir = tmpdir();
      const tmpFiles = readdirSync(tmpDir).filter((f) => f.startsWith("openclaw-agent-") && f.endsWith(".txt"));
      for (const file of tmpFiles) {
        try {
          const filePath = join(tmpDir, file);
          const mtime = statSync(filePath).mtimeMs;
          if (now - mtime > TMP_OUTPUT_MAX_AGE_MS) {
            unlinkSync(filePath);
          }
        } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }

    // Evict oldest persisted sessions
    const all = this.listPersistedSessions();
    if (all.length > this.maxPersistedSessions) {
      const toEvict = all.slice(this.maxPersistedSessions);
      for (const info of toEvict) {
        this.persisted.delete(info.harnessSessionId);
        // Clean indexes
        for (const [k, v] of this.idIndex) {
          if (v === info.harnessSessionId) this.idIndex.delete(k);
        }
        for (const [k, v] of this.nameIndex) {
          if (v === info.harnessSessionId) this.nameIndex.delete(k);
        }
      }
    }
  }
}
