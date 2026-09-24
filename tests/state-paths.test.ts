import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveCodeAgentStateDir, resolveOpenClawStateDir, resolveSessionOutputDir } from "../src/state-paths";
import { resolveSessionIndexPath } from "../src/session-store-storage";

describe("state paths", () => {
  it("follows the host OPENCLAW_STATE_DIR / OPENCLAW_HOME rules", () => {
    assert.equal(resolveOpenClawStateDir({ OPENCLAW_STATE_DIR: "/srv/openclaw-state" }), "/srv/openclaw-state");
    // OPENCLAW_HOME is the home-directory override; the state dir lives beneath it.
    assert.equal(resolveOpenClawStateDir({ OPENCLAW_HOME: "/srv/home" }), join("/srv/home", ".openclaw"));
  });

  it("keeps plugin-owned files under plugin-state/openclaw-code-agent", () => {
    const env = { OPENCLAW_STATE_DIR: "/srv/state" };
    assert.equal(resolveCodeAgentStateDir(env), "/srv/state/plugin-state/openclaw-code-agent");
    assert.equal(resolveCodeAgentStateDir(env, "/other"), "/other/plugin-state/openclaw-code-agent");
    assert.equal(resolveSessionOutputDir(env), "/srv/state/plugin-state/openclaw-code-agent/output");
  });

  it("keeps the session index in the state dir unless explicitly overridden", () => {
    assert.equal(resolveSessionIndexPath({ OPENCLAW_STATE_DIR: "/srv/state" }), "/srv/state/code-agent-sessions.json");
    assert.equal(
      resolveSessionIndexPath({ OPENCLAW_STATE_DIR: "/srv/state", OPENCLAW_CODE_AGENT_SESSIONS_PATH: "/x/s.json" }),
      "/x/s.json",
    );
  });
});
