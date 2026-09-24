import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPackedFiles,
  extractPackedTarball,
  findNetworkGuardViolations,
} from "../scripts/check-clawhub-scan.mjs";

const metadata = {
  packageJson: { name: "openclaw-code-agent", description: "Coding agent sessions for OpenClaw." },
  pluginManifest: { name: "Code Agent" },
};

function check(files: Array<{ path: string; content: string }>) {
  return checkPackedFiles(files, metadata);
}

describe("ClawHub static scan gate", () => {
  it("lists every file of a packed tarball relative to the package root", () => {
    const dir = mkdtempSync(join(tmpdir(), "oca-clawhub-tarball-"));
    try {
      mkdirSync(join(dir, "package", "dist", "chunks"), { recursive: true });
      writeFileSync(join(dir, "package", "package.json"), "{}\n");
      writeFileSync(join(dir, "package", "dist", "chunks", "a.js"), "export {};\n");
      const tarball = join(dir, "pkg.tgz");
      execFileSync("tar", ["-czf", tarball, "-C", dir, "package"]);
      const extracted = extractPackedTarball(tarball);
      try {
        assert.deepEqual([...extracted.paths].sort(), ["dist/chunks/a.js", "package.json"]);
      } finally {
        extracted.cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a clean packed file set", () => {
    const { scan, problems } = check([
      { path: "dist/index.js", content: "export function add(a, b) { return a + b; }\n" },
      { path: "README.md", content: "# Code Agent\n\nRuns coding agents.\n" },
    ]);
    assert.equal(scan.status, "clean");
    assert.deepEqual(problems, []);
  });

  it("flags a bare spawn( call in a file that mentions child_process", () => {
    const { problems } = check([{
      path: "dist/index.js",
      content: 'import { spawn } from "node:child_process";\nexport function run(cmd, args) { return spawn(cmd, args); }\n',
    }]);
    assert.ok(problems.some((problem) => problem.startsWith("suspicious.dangerous_exec")), problems.join("\n"));
  });

  it("flags a bare method named spawn in a child_process file", () => {
    const { problems } = check([{
      path: "dist/index.js",
      content: 'import { execFile } from "node:child_process";\nclass M { spawn(x) { return x; } }\nnew M().spawn(1);\n',
    }]);
    assert.ok(problems.some((problem) => problem.startsWith("suspicious.dangerous_exec")), problems.join("\n"));
  });

  it("does not flag a literal execFile(\"git\", [...]) call", () => {
    const { scan, problems } = check([{
      path: "dist/index.js",
      content: 'import { execFile } from "node:child_process";\nexport function head(cwd) { return execFile("git", ["rev-parse", "HEAD"], { cwd }); }\n',
    }]);
    assert.equal(scan.status, "clean");
    assert.deepEqual(problems, []);
  });

  it("flags fetch( outside the npm release-client chunk", () => {
    const problems = findNetworkGuardViolations([
      { path: "dist/chunks/npm-release-client-ABC123.js", content: "export const get = (u) => fetch(u);\n" },
      { path: "dist/index.js", content: "export const get = (u) => fetch(u);\n" },
    ]);
    assert.deepEqual(problems, ["dist/index.js: fetch( outside the npm release-client chunk"]);
  });

  it("flags process.env combined with a network call in one file", () => {
    const problems = findNetworkGuardViolations([
      {
        path: "dist/chunks/npm-release-client-ABC123.js",
        content: "export const get = () => fetch(process.env.REGISTRY);\n",
      },
    ]);
    assert.deepEqual(problems, ["dist/chunks/npm-release-client-ABC123.js: process.env and a network call in the same file"]);
    const { problems: gateProblems } = check([
      { path: "dist/chunks/npm-release-client-ABC123.js", content: "export const get = () => fetch(process.env.REGISTRY);\n" },
    ]);
    assert.ok(gateProblems.includes("dist/chunks/npm-release-client-ABC123.js: process.env and a network call in the same file"));
  });

  it("allows process.env in files without network calls", () => {
    assert.deepEqual(findNetworkGuardViolations([
      { path: "dist/index.js", content: "export const home = process.env.HOME;\n" },
    ]), []);
  });
});
