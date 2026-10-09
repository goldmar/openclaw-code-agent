import "./test-env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { compatibilityDiagnosticSecrets, validateCompatibilityHost, validateDiscoveryRejection,
  validateHostMinimumRejection, writeCompatibilityFailureLog } from "../scripts/check-openclaw-compatibility.mjs";
import packageMetadata from "../package.json";

const incompatible = "plugin requires plugin API >=2099.1.1, but this host is 2026.9.8;";
const invalid = "invalid package plugin API metadata:";
const rejected = {
  plugins: [] as Array<{ id: string; status: string }>,
  diagnostics: [{ pluginId: "openclaw-code-agent", configDisposition: "preserve",
    message: `${incompatible} skipping discovery (check "openclaw --version")` }],
};

describe("compatibility fixture cleanup and diagnostics", () => {
  it("replaces a permissive log with a private file and redacts exact credential values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oca-compat-log-"));
    try {
      const log = join(directory, "failure.log");
      await writeFile(log, "old diagnostics", { mode: 0o644 });
      await chmod(log, 0o644); // Make the regression independent of the runner's umask.
      assert.equal((await stat(log)).mode & 0o777, 0o644);
      const secrets = compatibilityDiagnosticSecrets({ OCA_API_KEY: "env value with spaces",
        OCA_PASSWORD: "password=value", ORDINARY: "ordinary detail" },
      ["--token", "argument value with spaces", "--client-secret=equal=value", "--port", "1234"]);
      const gatewayToken = "fixture-gateway-auth";
      await writeCompatibilityFailureLog(log,
        "ordinary detail\nenv value with spaces\npassword=value\nargument value with spaces\nequal=value\n"
        + `${gatewayToken}\n`, [...secrets, gatewayToken]);
      assert.equal((await stat(log)).mode & 0o777, 0o600);
      assert.equal(await readFile(log, "utf8"), "ordinary detail\n" + "[redacted credential]\n".repeat(5));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces a destination symlink without writing through it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oca-compat-symlink-"));
    try {
      const target = join(directory, "target.log");
      const log = join(directory, "failure.log");
      await writeFile(target, "must remain unchanged", { mode: 0o644 });
      await chmod(target, 0o644);
      await symlink(target, log);
      await writeCompatibilityFailureLog(log, "safe diagnostic", []);
      assert.equal((await lstat(log)).isSymbolicLink(), false);
      assert.equal((await stat(log)).mode & 0o777, 0o600);
      assert.equal(await readFile(log, "utf8"), "safe diagnostic");
      assert.equal(await readFile(target, "utf8"), "must remain unchanged");
      assert.equal((await stat(target)).mode & 0o777, 0o644);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes the real provider after a failed config write and lets the child exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oca-compat-cleanup-"));
    try {
      const checker = new URL("../scripts/check-openclaw-compatibility.mjs", import.meta.url).href;
      const child = `
        import assert from "node:assert/strict";
        const { withCompatibilityProvider } = await import(process.argv[1]);
        const { createCronCompatibilityProvider } = await import(new URL("./lib/openclaw-compatibility-cron.mjs", process.argv[1]));
        let closed = false;
        try {
          await withCompatibilityProvider({ agents: { defaults: {} } }, process.argv[2],
            () => { throw new Error("Gateway must not start after a failed config write"); },
            async () => {
              const provider = await createCronCompatibilityProvider();
              return { ...provider, async close() { await provider.close(); closed = true; } };
            });
          throw new Error("Expected config write to fail");
        } catch (error) {
          assert.equal(error.code, "ENOENT");
          assert.equal(closed, true);
          console.log("provider closed");
          process.exitCode = 1;
        }
      `;
      await assert.rejects(promisify(execFile)(process.execPath,
        ["--input-type=module", "--eval", child, checker, join(directory, "missing", "config.json")],
        { timeout: 5_000 }), (error: unknown) => {
        // execFile adds process diagnostics to the rejection; require a natural exit, not timeout cleanup.
        const result = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
        assert.equal(result.killed, false);
        assert.equal(result.code, 1);
        assert.equal(result.stdout, "provider closed\n");
        assert.equal(result.stderr, "");
        return true;
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("compatibility discovery acceptance", () => {
  it("requires explicit negative intent for a previous host and refuses target/newer hosts", () => {
    validateCompatibilityHost(packageMetadata, packageMetadata.openclaw.build.openclawVersion);
    validateCompatibilityHost(packageMetadata, "2026.9.7");
    validateCompatibilityHost(packageMetadata, "2026.9.8", true);
    validateCompatibilityHost(packageMetadata, "2026.9.7", true);
    assert.throws(() => validateCompatibilityHost(packageMetadata, "2026.9.8"));
    for (const version of ["2026.9.9", "2026.9.10", "2026.10.1", "2027.1.1", "2026.9.8-rc.1"]) {
      assert.throws(() => validateCompatibilityHost(packageMetadata, version, true));
    }
  });
  it("requires an explicit unchanged-artifact rejection on the older host", () => {
    const result = { ...rejected, diagnostics: [{ pluginId: "openclaw-code-agent",
      message: "plugin requires OpenClaw >=2026.9.8, but this host is 2026.9.7; skipping load" }] };
    validateHostMinimumRejection(result, "configured", "configured", ">=2026.9.8", "2026.9.7");
    assert.throws(() => validateHostMinimumRejection({}, "configured", "configured", ">=2026.9.8", "2026.9.7"));
    assert.throws(() => validateHostMinimumRejection(result, "configured", "changed", ">=2026.9.8", "2026.9.7"));
    assert.throws(() => validateHostMinimumRejection(result, "configured", "configured", ">=2026.9.8", "2026.9.6"));
    assert.throws(() => validateHostMinimumRejection({ ...result,
      plugins: [{ id: "openclaw-code-agent", status: "loaded" }],
    }, "configured", "configured", ">=2026.9.8", "2026.9.7"));
  });

  it("accepts an explicit preserved discovery rejection", () => {
    validateDiscoveryRejection(rejected, "configured", "configured", incompatible);
    validateDiscoveryRejection({ ...rejected, diagnostics: [{ ...rejected.diagnostics[0],
      message: `${invalid} bad range; skipping discovery (check package.json openclaw.compat.pluginApi)` }],
    }, "configured", "configured", invalid);
  });

  it("refuses the diagnostic of a different rejected declaration", () => {
    assert.throws(() => validateDiscoveryRejection(rejected, "configured", "configured", invalid));
    assert.throws(() => validateDiscoveryRejection({ ...rejected, diagnostics: [{ ...rejected.diagnostics[0],
      message: `${incompatible} loaded anyway` }],
    }, "configured", "configured", incompatible));
  });

  it("refuses an empty report or an unrelated diagnostic", () => {
    assert.throws(() => validateDiscoveryRejection({}, "configured", "configured", incompatible));
    assert.throws(() => validateDiscoveryRejection({ ...rejected,
      diagnostics: [{ ...rejected.diagnostics[0], pluginId: "other-plugin" }],
    }, "configured", "configured", incompatible));
  });

  it("refuses a loaded plugin even if an earlier diagnostic says it was skipped", () => {
    assert.throws(() => validateDiscoveryRejection({ ...rejected,
      plugins: [{ id: "openclaw-code-agent", status: "loaded" }],
    }, "configured", "configured", incompatible));
    assert.throws(() => validateDiscoveryRejection({ ...rejected,
      plugins: [{ id: "openclaw-code-agent", status: "error", toolNames: ["agent_launch"] }],
    }, "configured", "configured", incompatible));
  });

  it("refuses lost configuration or a diagnostic without preservation", () => {
    assert.throws(() => validateDiscoveryRejection(rejected, "configured", "removed", incompatible));
    assert.throws(() => validateDiscoveryRejection({ ...rejected,
      diagnostics: [{ ...rejected.diagnostics[0], configDisposition: "remove" }],
    }, "configured", "configured", incompatible));
  });
});
