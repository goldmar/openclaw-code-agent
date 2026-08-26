#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const testRoot = mkdtempSync(join(tmpdir(), "oca-npm-consumer-"));

function runNpm(args, cwd, options = {}) {
  return execFileSync(npmCommand, args, {
    cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function requireDependency(node, name, version, path) {
  const dependency = node?.dependencies?.[name];
  if (!dependency) throw new Error(`npm consumer graph is missing ${path} -> ${name}`);
  if (dependency.version !== version) {
    throw new Error(
      `npm consumer graph resolved ${path} -> ${name}@${dependency.version}, expected ${version}`,
    );
  }
  return dependency;
}

try {
  const artifactDir = join(testRoot, "artifact");
  const consumerDir = join(testRoot, "consumer");
  const hostDir = join(testRoot, "host");
  mkdirSync(artifactDir);
  mkdirSync(consumerDir);
  mkdirSync(hostDir);
  writeFileSync(
    join(hostDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }, null, 2)}\n`,
  );

  const pack = JSON.parse(
    runNpm(["pack", rootDir, "--json", "--pack-destination", artifactDir], rootDir, {
      capture: true,
    }),
  );
  const packed = pack[0];
  if (!packed?.filename) throw new Error("npm pack did not return an artifact filename");
  if (!packed.files?.some((file) => file.path === "npm-shrinkwrap.json")) {
    throw new Error("packed artifact does not contain npm-shrinkwrap.json");
  }
  const artifactPath = join(artifactDir, packed.filename);
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "oca-npm-consumer-verification",
        private: true,
        dependencies: {
          openclaw: `file:${hostDir}`,
          [packageJson.name]: `file:${artifactPath}`,
        },
      },
      null,
      2,
    )}\n`,
  );

  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    consumerDir,
  );
  const audit = JSON.parse(
    runNpm(["audit", "--omit=dev", "--json"], consumerDir, { capture: true }),
  );
  if (audit.metadata?.vulnerabilities?.total !== 0) {
    throw new Error(`npm consumer audit found vulnerabilities: ${JSON.stringify(audit.vulnerabilities)}`);
  }

  const tree = JSON.parse(runNpm(["ls", "--all", "--json"], consumerDir, { capture: true }));
  const plugin = requireDependency(tree, packageJson.name, packageJson.version, "consumer");
  const mcp = requireDependency(plugin, "@modelcontextprotocol/sdk", "1.30.0", packageJson.name);
  const ajv = requireDependency(mcp, "ajv", "8.20.0", "@modelcontextprotocol/sdk");
  const rateLimit = requireDependency(
    mcp,
    "express-rate-limit",
    "8.6.2",
    "@modelcontextprotocol/sdk",
  );
  requireDependency(mcp, "@hono/node-server", "2.1.1", "@modelcontextprotocol/sdk");
  requireDependency(mcp, "hono", "4.12.34", "@modelcontextprotocol/sdk");
  requireDependency(ajv, "fast-uri", "3.1.5", "ajv");
  requireDependency(plugin, "ip-address", "10.5.0", packageJson.name);

  console.log(`npm consumer install validated ${packageJson.name}@${packageJson.version}`);
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
