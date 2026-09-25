import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setPluginConfig } from "../src/config";
import { executeRespond } from "../src/actions/respond";
import { BACKEND_NAMES, CodexBackend, waitUntil, type BackendName, type PermissionOutcome } from "./harness-backends";
import { buttonNamed, clickButton, startInteractionFixture, type InteractionFixture } from "./user-interaction-fixture";

let fixture: InteractionFixture | undefined;

afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  setPluginConfig({});
});

/** Labels of the approve-once / approve-for-session / decline buttons per backend. */
const LABELS: Record<Exclude<BackendName, "claude-code">, { once: string; always: string; decline: string; all: string[] }> = {
  codex: {
    once: "Approve once",
    always: "Approve for session",
    decline: "Decline",
    all: ["Approve once", "Approve for session", "Decline", "Decline and stop turn"],
  },
  opencode: {
    once: "Allow once",
    always: "Always allow",
    decline: "Reject",
    all: ["Allow once", "Always allow", "Reject"],
  },
};

async function start(name: BackendName): Promise<InteractionFixture> {
  // Codex asks for approvals only under an on-request approval policy.
  setPluginConfig({
    harnesses: { codex: { permissionProfile: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "user" } },
  });
  return await startInteractionFixture(name);
}

async function requestAndWait(): Promise<{ decided: Promise<PermissionOutcome> }> {
  const f = fixture!;
  const decided = f.backend.requestPermission("rm -rf build");
  await waitUntil(() => f.session.pendingInputState?.kind === "approval", "pending permission request");
  return { decided };
}

async function permissionButtons() {
  const f = fixture!;
  await waitUntil(() => f.buttons("waiting").length > 0, "permission buttons");
  return f.buttons("waiting");
}

for (const name of BACKEND_NAMES) {
  if (name === "claude-code") {
    describe("claude-code: permission requests", () => {
      it("skips permission prompts: Claude Code sessions run tools without interactive permission requests", () => {});
    });
    continue;
  }
  const labels = LABELS[name];

  describe(`${name}: permission requests`, () => {
    if (name === "codex") {
      it("starts the thread under the on-request approval policy", async () => {
        fixture = await start(name);
        const thread = (fixture.backend as CodexBackend).threadStartParams[0];
        assert.equal(thread?.approvalPolicy, "on-request");
        assert.equal(thread?.approvalsReviewer, "user");
      });
    }

    it("shows the request with one button per decision", async () => {
      fixture = await start(name);
      await requestAndWait();
      assert.match(fixture.session.pendingInputState?.promptText ?? "", /rm -rf build/);
      assert.deepEqual((await permissionButtons()).map((button) => button.label), labels.all);
    });

    for (const [decision, label] of [["accept", labels.once], ["acceptForSession", labels.always], ["decline", labels.decline]] as const) {
      it(`answers "${label}" from a Telegram button`, async () => {
        fixture = await start(name);
        const { decided } = await requestAndWait();
        const click = await clickButton(buttonNamed(await permissionButtons(), label));
        assert.deepEqual(click.replies, ["✅ Pending input request submitted."]);
        assert.deepEqual(await decided, { decision });
        await waitUntil(() => !fixture!.session.pendingInputState, "request cleared");
      });
    }

    it("answers from a Discord button and reports a second click as no longer active", async () => {
      fixture = await start(name);
      const { decided } = await requestAndWait();
      const buttons = await permissionButtons();
      const click = await clickButton(buttonNamed(buttons, labels.once), "discord");
      assert.deepEqual(click.replies, ["✅ Pending input request submitted."]);
      assert.deepEqual(await decided, { decision: "accept" });

      const again = await clickButton(buttonNamed(buttons, labels.decline), "discord");
      assert.match(again.replies.join("\n"), /no longer active/);
    });

    for (const [reply, decision] of [["yes", "accept"], ["always", "acceptForSession"], ["no", "decline"], ["2", "acceptForSession"]] as const) {
      it(`maps the agent_respond reply "${reply}" to ${decision}`, async () => {
        fixture = await start(name);
        const { decided } = await requestAndWait();
        const result = await executeRespond(fixture.sm, { session: fixture.session.id, message: reply, userInitiated: true });
        assert.equal(result.isError, undefined, result.text);
        assert.match(result.text, /Pending input request submitted/);
        assert.deepEqual(await decided, { decision });
      });
    }

    it("declines and forwards any other reply to the agent as feedback", async () => {
      fixture = await start(name);
      const { decided } = await requestAndWait();
      const feedback = "Use the dry-run flag instead";
      const result = await executeRespond(fixture.sm, { session: fixture.session.id, message: feedback, userInitiated: true });
      assert.equal(result.isError, undefined, result.text);
      if (name === "codex") {
        assert.deepEqual(await decided, { decision: "decline" });
        await waitUntil(() => fixture!.backend.steers.includes(feedback), "feedback steered into the turn");
      } else {
        assert.deepEqual(await decided, { decision: "decline", message: feedback });
      }
    });

    it("rejects an empty reply without deciding the request", async () => {
      fixture = await start(name);
      const { decided } = await requestAndWait();
      const result = await executeRespond(fixture.sm, { session: fixture.session.id, message: " ", userInitiated: true });
      assert.equal(result.isError, true);
      assert.match(result.text, /The answer is empty/);
      assert.equal(fixture.session.pendingInputState?.kind, "approval", "the request stays pending");
      await clickButton(buttonNamed(await permissionButtons(), labels.decline));
      assert.deepEqual(await decided, { decision: "decline" });
    });
  });
}
