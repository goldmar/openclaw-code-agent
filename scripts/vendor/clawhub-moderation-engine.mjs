// GENERATED FILE - DO NOT EDIT. Regenerate with `node scripts/sync-clawhub-scan.mjs --clawhub <dir>`.
// Source: https://github.com/openclaw/clawhub (convex/lib/moderationEngine.ts) at commit 9a614dc195afbe1b6834065c6521018b8100afde.
// Vendored so CI can run ClawHub's static moderation scan against the packed plugin.
//
// MIT License
//
// Copyright (c) 2026 Peter Steinberger
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// convex/lib/moderationReasonCodes.ts
var MODERATION_ENGINE_VERSION = "v2.4.26";
var REASON_CODES = {
  LLM_REVIEW: "review.llm_review",
  DANGEROUS_EXEC: "suspicious.dangerous_exec",
  DYNAMIC_CODE: "suspicious.dynamic_code_execution",
  GENERATED_SOURCE_TEMPLATE: "suspicious.generated_source_template_injection",
  EXPOSED_RESOURCE_IDENTIFIER: "suspicious.exposed_resource_identifier",
  DESTRUCTIVE_DELETE_COMMAND: "suspicious.destructive_delete_command",
  EXPOSED_SECRET_LITERAL: "suspicious.exposed_secret_literal",
  CREDENTIAL_EXPOSURE_INSTRUCTIONS: "suspicious.credential_exposure_instructions",
  SECRET_ARGV_EXPOSURE: "suspicious.secret_argv_exposure",
  HOST_PLATFORM_SOURCE_PATCH: "suspicious.host_platform_source_patch",
  UNSAFE_FILE_WRITE: "suspicious.unsafe_file_write",
  INSECURE_TLS_VERIFICATION: "suspicious.insecure_tls_verification",
  AUTONOMOUS_CREDENTIAL_EGRESS: "suspicious.autonomous_credential_egress",
  HARDCODED_OPERATOR_BILLING: "suspicious.hardcoded_operator_billing",
  REMOTE_RECIPE_EXECUTION: "suspicious.remote_recipe_execution",
  CONFIRMATION_BYPASS: "suspicious.confirmation_bypass",
  CREDENTIAL_HARVEST: "suspicious.env_credential_access",
  EXFILTRATION: "suspicious.potential_exfiltration",
  OBFUSCATED_CODE: "suspicious.obfuscated_code",
  SUSPICIOUS_NETWORK: "suspicious.nonstandard_network",
  CRYPTO_MINING: "malicious.crypto_mining",
  INJECTION_INSTRUCTIONS: "suspicious.prompt_injection_instructions",
  SUSPICIOUS_INSTALL_SOURCE: "suspicious.install_untrusted_source",
  MANIFEST_PRIVILEGED_ALWAYS: "suspicious.privileged_always",
  MALICIOUS_INSTALL_PROMPT: "malicious.install_terminal_payload",
  KNOWN_BLOCKED_SIGNATURE: "malicious.known_blocked_signature"
};
var MALICIOUS_CODES = /* @__PURE__ */ new Set([
  REASON_CODES.CRYPTO_MINING,
  REASON_CODES.MALICIOUS_INSTALL_PROMPT,
  REASON_CODES.KNOWN_BLOCKED_SIGNATURE
]);
var EXTERNALLY_CLEARABLE_SUSPICIOUS_CODES = /* @__PURE__ */ new Set([REASON_CODES.CREDENTIAL_HARVEST]);
function normalizeReasonCodes(codes) {
  return Array.from(new Set(codes.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}
function summarizeReasonCodes(codes) {
  if (codes.length === 0) return "No suspicious patterns detected.";
  const top = codes.slice(0, 3).join(", ");
  const extra = codes.length > 3 ? ` (+${codes.length - 3} more)` : "";
  if (codes.every((code) => code.startsWith("review."))) return `Review: ${top}${extra}`;
  return `Detected: ${top}${extra}`;
}
function verdictFromCodes(codes) {
  const normalized = normalizeReasonCodes(codes);
  if (normalized.some((code) => MALICIOUS_CODES.has(code) || code.startsWith("malicious."))) {
    return "malicious";
  }
  if (normalized.some((code) => code.startsWith("suspicious."))) return "suspicious";
  return "clean";
}
function legacyFlagsFromVerdict(verdict) {
  if (verdict === "malicious") return ["blocked.malware"];
  if (verdict === "suspicious") return ["flagged.suspicious"];
  return void 0;
}

// convex/lib/moderationEngine.ts
var MANIFEST_EXTENSION = /\.(json|yaml|yml|toml)$/i;
var MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i;
var CODE_EXTENSION = /\.(js|ts|mjs|cjs|mts|cts|jsx|tsx|py|sh|bash|zsh|rb|go)$/i;
var STANDARD_PORTS = /* @__PURE__ */ new Set([80, 443, 8080, 8443, 3e3]);
var RAW_IP_URL_PATTERN = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|["'])/i;
var CGNAT_HTTP_URL_PATTERN = /http:\/\/100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?::\d+)?(?:\/[^\s"'`]*)?/i;
var INSTALL_PACKAGE_PATTERN = /installer-package\s*:\s*https?:\/\/[^\s"'`]+/i;
var GENERATED_SOURCE_PLACEHOLDER_PATTERN = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=.*["']\$\{[A-Za-z_][A-Za-z0-9_-]*\}["']/m;
var GENERATED_SOURCE_CONTEXT_PATTERN = /```(?:python|py|javascript|js|typescript|ts|shell|bash|sh)\b|cat\s*(?:>|>>)?\s*[^`\n]*\.(?:py|js|ts|sh)\b|python3?\b|node\b/i;
var HARDCODED_CONNECTION_ID_PATTERN = /["']connection_id["']\s*:\s*["'][0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}["']/i;
var GOOGLE_SHEETS_SPREADSHEET_URL_PATTERN = /https?:\/\/[^\s"'`]*\/spreadsheets\/([A-Za-z0-9_-]{20,})\/[^\s"'`]*/i;
var DESTRUCTIVE_DELETE_PATTERN = /\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(["']?)(\/root\/\.openclaw\/|\/home\/[^/\s"'`]+\/\.openclaw\/|\/Users\/[^/\s"'`]+\/\.openclaw\/|~\/\.openclaw\/|\$HOME\/\.openclaw\/|\$\{HOME\}\/\.openclaw\/|\/etc\/|\/usr\/|\/opt\/|\/Library\/|\/Applications\/)[^\s"'`;|&)]*\1/i;
var SECRET_FIELD_PATTERN_SOURCE = String.raw`(?:[A-Za-z0-9]+[_\s-]+)*(?:(?:api|client|consumer)[_\s-]?(?:secret|key|token)|secret[_\s-]?key|access[_\s-]?(?:token|key|secret|grant)|auth[_\s-]?token|bearer(?:[_\s-]?token)?|private[_\s-]?key|service[_\s-]?role[_\s-]?key|github[_\s-]?(?:pat|token)|(?:openrouter|supabase|storj)[_\s-]?(?:key|token|secret|access[_\s-]?grant)|password)`;
var SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b${SECRET_FIELD_PATTERN_SOURCE}\b\s*[:=]\s*(.+)$`,
  "i"
);
var AUTH_HEADER_SECRET_PATTERN = /\b(?:authorization|x-api-key|x-api-secret)\b\s*[:=]\s*(?:Bearer\s+)?(?:(["'`])([^"'`]{15,})\1|([A-Za-z0-9][A-Za-z0-9._~+/=-]{15,}))/i;
var KNOWN_SECRET_PREFIX_PATTERN = /^(?:sk[-_]|ak[-_]|pk[-_]|gh[opsu]_|xox[baprs]-|ya29\.|eyJ)/;
var SHELL_CREDENTIAL_VARIABLE_PATTERN = /\$(?:\{)?[A-Z_][A-Z0-9_]*(?:TOKEN|PAT|SECRET|KEY)[A-Z0-9_]*(?:\})?/;
var GIT_REMOTE_CREDENTIAL_URL_PATTERN = /\bgit\s+remote\s+set-url\b[^\n]*https?:\/\/[^\s"'`]*\$(?:\{)?[A-Z_][A-Z0-9_]*(?:TOKEN|PAT|SECRET|KEY)[A-Z0-9_]*(?:\})?[^\s"'`]*@/i;
var MEMORY_CREDENTIAL_STORAGE_PATTERN = /\bsave\s+(?:it|the\s+(?:token|secret|credential|key|pat))\s+to\s+(?:your\s+)?(?:memory|conversation|chat)\b/i;
var HOST_PLATFORM_SOURCE_CONTEXT_PATTERN = /\$[{]?OPENCLAW_DIR[}]?.{0,200}\/src\/|\/src\/agents\/|\/src\/tools\//is;
var HOST_PLATFORM_PATCH_COMMAND_PATTERN = /\b(?:sed\s+-i|perl\s+-0?pi|cp\s+|cat\s+>|python3?\b.{0,120}(?:write|replace))/i;
var HOST_PLATFORM_REBUILD_PATTERN = /\b(?:pnpm\s+build|npm\s+run\s+build|bun\s+run\s+build)\b/i;
var SECRET_ARGV_WARNING_PATTERN = /\b(?:do\s+not|don't|avoid|never|reject)\b[^\n]{0,120}\b(?:argv|argument|from-mnemonic|private[-_\s]?key|seed[-\s]?phrase|mnemonic)\b/i;
var FROM_MNEMONIC_ARGV_PATTERN = /\b(?:npx|bunx|pnpm\s+dlx|npm\s+exec|node|python3?|uvx)\b[^\n]{0,200}\bfrom-mnemonic\b[^\n]{0,200}(?:"[^"\n]{8,}"|'[^'\n]{8,}'|<[^>\n]{6,}>|\$[A-Z_][A-Z0-9_]*(?:MNEMONIC|SEED|PHRASE)[A-Z0-9_]*)/i;
var SECRET_FLAG_ARGV_PATTERN = /\b(?:npx|bunx|pnpm\s+dlx|npm\s+exec|node|python3?|uvx|docker\s+run)\b[^\n]{0,240}--(?:private-key|seed|seed-phrase|mnemonic|password|token)\s+(?:"[^"\n]{8,}"|'[^'\n]{8,}'|<[^>\n]{4,}>|\$[A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|MNEMONIC|SEED|PHRASE)[A-Z0-9_]*)/i;
var SECRET_ARGV_REDACTION_PATTERN = /(\b(?:from-mnemonic|--(?:private-key|seed|seed-phrase|mnemonic|password|token))\s+)(["'`])([^"'`]{8,})\2/gi;
var DYNAMIC_CODE_EXECUTION_PATTERN = /(?<![\w$.])eval\s*\(|new\s+Function\s*\(|\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?loader\.exec_module\s*\(/g;
var SHELL_BASE64_FILE_READ_PATTERN = /(?:\bcat\s+["']?\$[A-Za-z_][A-Za-z0-9_]*(?:file|path|input|image|document|pdf)[A-Za-z0-9_]*["']?\s*\|\s*base64\b|\bbase64\b[^\n]{0,80}["']?\$[A-Za-z_][A-Za-z0-9_]*(?:file|path|input|image|document|pdf)[A-Za-z0-9_]*["']?)/i;
var SHELL_NETWORK_UPLOAD_PATTERN = /\bcurl\b[\s\S]{0,1600}(?:--data(?:-binary|-raw)?\b|-d\b|--form\b|-F\b|--upload-file\b|Authorization\s*:)/i;
var PYTHON_BASE64_FILE_READ_PATTERN = /base64\.b64encode\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*\.read_bytes\s*\(\s*\)|Path\s*\([^)]*\)\.read_bytes\s*\(\s*\)|open\s*\([^)]*["']rb["'][\s\S]{0,120}\.read\s*\(\s*\))/i;
var PYTHON_NETWORK_UPLOAD_PATTERN = /\b(?:requests|session|self\.session|client|httpx\.(?:post|request))\.post\s*\([\s\S]{0,1600}(?:json\s*=|data\s*=|files\s*=|headers\s*=|Authorization)/i;
var AGENT_OUTPUT_DIR_ARGUMENT_PATTERN = /add_argument\s*\(\s*["']--outdir["']|args\.outdir|output_path\s*=\s*Path\s*\(\s*args\.outdir\s*\)/i;
var FFMPEG_FORCE_OUTPUT_PATTERN = /subprocess\.run\s*\(\s*\[[\s\S]{0,1000}["']ffmpeg["'][\s\S]{0,1000}["']-y["'][\s\S]{0,1000}str\s*\(\s*output_path\s*\)/i;
var OUTPUT_PATH_GUARD_PATTERN = /TemporaryDirectory|mkdtemp|tempfile\.|resolve\s*\(\s*\).*relative_to|is_relative_to\s*\(/i;
var INSECURE_TLS_VERIFICATION_PATTERN = /ssl\._create_unverified_context\s*\(|ssl\.CERT_NONE\b|check_hostname\s*=\s*False\b|verify\s*=\s*False\b|rejectUnauthorized\s*:\s*false\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0["']?/i;
var PYTHON_AGENT_FILENAME_PATTERN = /\b(?:filename\s*:\s*str|req\.filename|filename\s*=|["']filename["'])\b/i;
var PYTHON_RCLONE_FILENAME_SINK_PATTERN = /(?:rclone_dir\s*\/\s*filename|f["']\.\/\{filename\}|open\s*\(\s*temp_file_path\s*,|subprocess\.run\s*\([\s\S]{0,1000}["']\.\/rclone["'])/i;
var PYTHON_FILENAME_GUARD_PATTERN = /\b(?:secure_filename|basename\s*\(|Path\s*\(\s*filename\s*\)\.name|filename\s*=\s*Path\s*\(\s*filename\s*\)\.name|resolve\s*\(\s*\).*relative_to|is_relative_to\s*\(|["']\.\.["']\s+in\s+filename|["']\/["']\s+in\s+filename)/i;
var PYTHON_CREDENTIAL_ENV_PATTERN = /\b(?:os\.environ(?:\.get)?|os\.getenv|getenv)\s*(?:\[\s*|\(\s*)["'][A-Za-z_][A-Za-z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY)[A-Za-z0-9_]*["']/i;
var PYTHON_URL_ENV_PATTERN = /\b(?:os\.environ(?:\.get)?|os\.getenv|getenv)\s*(?:\[\s*|\(\s*)["'][A-Za-z_][A-Za-z0-9_]*(?:BASE_URL|URL|HOST|ENDPOINT)[A-Za-z0-9_]*["']/i;
var PYTHON_HTTP_POST_PATTERN = /\b(?:requests|session|self\.session|client)\.post\s*\(|\.post\s*\(/i;
var PASSWORD_PAYLOAD_PATTERN = /["']password["']\s*:|password\s*=/i;
var JS_FILE_READ_PATTERN = /\b(?:readFileSync|readFile)\s*\(/;
var JS_NETWORK_SEND_PATTERN = /\bfetch\s*\(|http\.request\s*\(|\baxios\b/;
var SENSITIVE_FILE_READ_CONTEXT_PATTERN = /(?:readFileSync|readFile)\s*\([^)]*(?:secret|token|credential|password|passwd|private[-_]?key|\.env\b|\.ssh\/|\.aws\/|\.config\/|keychain|cookies?|session|auth|\/etc\/|\/Library\/|\/Users\/[^/\s"'`]+\/Library\/Application Support)/i;
var SENSITIVE_LOCAL_VALUE_NAME_PATTERN = /(?:secret|token|credential|password|passwd|privateKey|private_key|apiKey|api_key|session|cookie|auth)/i;
var AUTONOMOUS_AGENT_SCHEDULE_PATTERN = /\bAUTO_ANSWER\s*=\s*(?:true|os\.getenv\s*\(\s*["']AUTO_ANSWER["']\s*,\s*["']true["'])|while\s+True\s*:|time\.sleep\s*\(\s*(?:[3-9]\d{2,}|[1-9]\d{3,})\s*\)|\binterval\s*=\s*(?:[3-9]\d{2,}|[1-9]\d{3,})|"kind"\s*:\s*"cron"|"expr"\s*:\s*["'][^"']*\*\/(?:[1-5]?\d)\b/is;
var CREDENTIAL_BEARING_AGENT_PATTERN = /\b(?:X-API-Key|api_key|API_KEY|VDOOB_API_KEY|AGENT_ID|agent_config\.json)\b/i;
var AUTONOMOUS_ANSWER_EGRESS_PATTERN = /\b(?:requests|session|client)\.post\s*\([\s\S]{0,1000}(?:submit-answer|agent-withdrawals|agents\/register|messages\/agent)|\b(?:submit_answer|answer_question|act_cron_check)\b/i;
var HARDCODED_OPERATOR_BASE_URL_PATTERN = /\bBASE_URL\s*=\s*["']https:\/\/(?!your-|example\.|localhost\b|127\.0\.0\.1\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:\/[^"']*)?["']/i;
var OAUTH_CLIENT_SECRET_FLOW_PATTERN = /\b(?:oauth\/register|oauth\/token|client_secret|Authorization:\s*Bearer|ACCESS_TOKEN)\b/i;
var LIGHTNING_BILLING_FLOW_PATTERN = /\b(?:billing\/agent\/(?:create|check)-invoice|amount_sats|LNURL|Lightning|PAYG)\b/i;
var OUTBOUND_POST_PATTERN = /\b(?:curl\s+-X\s+POST|requests\.post\s*\(|fetch\s*\()/i;
var REMOTE_RECIPE_FETCH_PATTERN = /\b(?:curl|requests\.get|fetch)\b[\s\S]{0,600}(?:error-codes\.json|recipes?\.json|patterns\.json|docs\.openclaw\.ai)|ERROR_CODES_URL\s*=/i;
var MUTABLE_RECIPE_STORE_PATTERN = /\b(?:error-patterns\.json|recipes?\.json|safe_auto|fix_recipe_id|["']command["'])\b/i;
var TEMPLATED_SUBPROCESS_EXECUTION_PATTERN = /\bsubstitute_params\s*\([\s\S]{0,500}\b(?:shlex\.split|subprocess\.run)\b|\b(?:shlex\.split|subprocess\.run)\b[\s\S]{0,500}\bsubstitute_params\s*\(/i;
var CONFIRMATION_BYPASS_TRIGGER_PATTERN = /\b(?:OPENCLAW_AGENT_CALL|SAFE_EXEC_AUTO_CONFIRM|SAFEXEC_CONTEXT|I understand the risk)\b/i;
var RISK_CONFIRMATION_CONTEXT_PATTERN = /\b(?:critical|high|medium|risk|approval|approve|confirm|confirmation|read\s+-p)\b/i;
var DIRECT_COMMAND_EVAL_PATTERN = /\beval\s+["']?\$command\b/i;
var HIGH_RISK_CONTEXT_EVAL_PATTERN = /\b(?:critical|high|medium)\b[\s\S]{0,900}\beval\s+["']?\$command\b|\bI understand the risk\b[\s\S]{0,1200}\beval\s+["']?\$command\b/i;
function hasMaliciousInstallPrompt(content) {
  const hasTerminalInstruction = /(?:copy|paste).{0,80}(?:command|snippet).{0,120}(?:terminal|shell)/is.test(content) || /run\s+it\s+in\s+terminal/i.test(content) || /open\s+terminal/i.test(content) || /for\s+macos\s*:/i.test(content);
  if (!hasTerminalInstruction) return false;
  const hasCurlPipe = /(?:curl|wget)\b[^\n|]{0,240}\|\s*(?:\/bin\/)?(?:ba)?sh\b/i.test(content);
  const hasBase64Exec = /(?:echo|printf)\s+["'][A-Za-z0-9+/=\s]{40,}["']\s*\|\s*base64\s+-?[dD]\b[^\n|]{0,120}\|\s*(?:\/bin\/)?(?:ba)?sh\b/i.test(
    content
  );
  const hasRawIpUrl = RAW_IP_URL_PATTERN.test(content);
  const hasInstallerPackage = INSTALL_PACKAGE_PATTERN.test(content);
  return hasBase64Exec || hasCurlPipe && (hasRawIpUrl || hasInstallerPackage);
}
function truncateEvidence(evidence, maxLen = 160) {
  if (evidence.length <= maxLen) return evidence;
  return `${evidence.slice(0, maxLen)}...`;
}
function looksLikePlaceholderIdentifier(identifier) {
  return /^[A-Z0-9_]+$/.test(identifier) || /(your|example|placeholder)/i.test(identifier);
}
function looksLikePlaceholderSecret(secret) {
  const normalized = secret.trim().toLowerCase();
  if (!normalized) return true;
  if (/^(?:x+|_+|-+|\*+|\.{3})$/.test(normalized)) return true;
  if (/process\.env\.|os\.environ[.[]|getenv\s*\(/.test(normalized)) return true;
  if (normalized.startsWith("secretref:")) return true;
  return /(your|example|placeholder|change-?me|replace|redacted|dummy|sample|test-token|token-here|secret-here|api-key-here)/i.test(
    normalized
  );
}
function readSecretCandidate(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    let escaped = false;
    for (let i = 1; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) return { secret: trimmed.slice(1, i), quoted: true };
    }
    return null;
  }
  const token = trimmed.match(/^[^\s,;#)"'`]+/)?.[0];
  return token ? { secret: token, quoted: false } : null;
}
function looksLikeCodeSecretReference(path, secret, quoted) {
  if (/[$}{]/.test(secret)) return true;
  if (quoted) return false;
  if (/^(?:process\.env|os\.environ|os\.getenv|getenv)\b/.test(secret)) return true;
  if (CODE_EXTENSION.test(path)) {
    if (/^[A-Za-z_$][\w$]*\??\./.test(secret)) return true;
    if (/^[A-Za-z_$][\w$]*\s*\(/.test(secret)) return true;
    if (/^[A-Za-z_$][\w$]*$/.test(secret)) return true;
  }
  return false;
}
function looksLikeHardcodedSecret(path, secret, quoted) {
  if (secret.length < 16) return false;
  const hasKnownSecretPrefix = KNOWN_SECRET_PREFIX_PATTERN.test(secret);
  if (hasKnownSecretPrefix) return true;
  if (looksLikePlaceholderSecret(secret)) return false;
  if (looksLikeCodeSecretReference(path, secret, quoted)) return false;
  const hasLetter = /[A-Za-z]/.test(secret);
  const hasLongNumericCredential = /\d{16,}/.test(secret);
  return hasKnownSecretPrefix || hasLetter || hasLongNumericCredential;
}
function findSecretAssignmentMatch(path, line) {
  const authMatch = line.match(AUTH_HEADER_SECRET_PATTERN);
  const authSecret = authMatch?.[2] ?? authMatch?.[3];
  if (authSecret && looksLikeHardcodedSecret(path, authSecret, Boolean(authMatch?.[2]))) {
    return authSecret;
  }
  const assignmentMatch = line.match(SECRET_ASSIGNMENT_PATTERN);
  const candidate = assignmentMatch?.[1] ? readSecretCandidate(assignmentMatch[1]) : null;
  if (!candidate) return null;
  return looksLikeHardcodedSecret(path, candidate.secret, candidate.quoted) ? candidate.secret : null;
}
function isTestFixtureFile(path) {
  return /(?:^|\/)(?:__tests__|fixtures?)\/|(?:\.test|\.spec)\.[^/]+$/i.test(path);
}
function isAllowedTestFixtureSecret(path, lines, lineIndex, secret) {
  if (!isTestFixtureFile(path)) return false;
  if (KNOWN_SECRET_PREFIX_PATTERN.test(secret)) return false;
  if (looksLikeNamedTestFixtureSecret(secret)) return true;
  const context = lines.slice(Math.max(0, lineIndex - 20), lineIndex + 3).join("\n");
  const escapedSecret = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parsedFromColonDelimitedToken = new RegExp(
    String.raw`\btoken\s*:\s*(["'])[^"'\n:]{1,80}:${escapedSecret}\1`
  ).test(context);
  return parsedFromColonDelimitedToken && /\bexpect\b[\s\S]{0,500}\btoStrictEqual\s*\(/.test(context);
}
function looksLikeNamedTestFixtureSecret(secret) {
  const normalized = secret.trim().toLowerCase();
  if (normalized !== secret.trim()) return false;
  if (/\d/.test(normalized)) return false;
  const parts = normalized.split(/[-_:/&=]+/).filter(Boolean);
  if (parts.length < 2) return false;
  const fixtureWords = /* @__PURE__ */ new Set([
    "api",
    "guid",
    "inline",
    "legacy",
    "level",
    "my",
    "new",
    "old",
    "ops",
    "password",
    "react",
    "recreated",
    "regression",
    "resolved",
    "secret",
    "socket",
    "stale",
    "super",
    "token",
    "top"
  ]);
  const credentialWords = /* @__PURE__ */ new Set(["api", "password", "secret", "token"]);
  return parts.every((part) => fixtureWords.has(part)) && parts.some((part) => credentialWords.has(part));
}
function findHardcodedSecret(path, content) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const secret = findSecretAssignmentMatch(path, line);
    if (!secret) continue;
    if (isAllowedTestFixtureSecret(path, lines, i, secret)) continue;
    return {
      line: i + 1,
      text: line.replaceAll(secret, "[REDACTED]")
    };
  }
  return null;
}
function findCredentialExposureInstruction(content) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (GIT_REMOTE_CREDENTIAL_URL_PATTERN.test(line) || MEMORY_CREDENTIAL_STORAGE_PATTERN.test(line) && SHELL_CREDENTIAL_VARIABLE_PATTERN.test(content)) {
      return { line: i + 1, text: line };
    }
  }
  return null;
}
function redactSecretArgvEvidence(line) {
  return line.replace(SECRET_ARGV_REDACTION_PATTERN, "$1$2[REDACTED]$2");
}
function findSecretArgvExposure(content) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (SECRET_ARGV_WARNING_PATTERN.test(line)) continue;
    if (FROM_MNEMONIC_ARGV_PATTERN.test(line) || SECRET_FLAG_ARGV_PATTERN.test(line)) {
      return { line: i + 1, text: redactSecretArgvEvidence(line) };
    }
  }
  return null;
}
function findHostPlatformSourcePatch(content) {
  if (!HOST_PLATFORM_SOURCE_CONTEXT_PATTERN.test(content)) return null;
  if (!HOST_PLATFORM_REBUILD_PATTERN.test(content)) return null;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!HOST_PLATFORM_PATCH_COMMAND_PATTERN.test(line)) continue;
    if (hasNearbyConfirmationGate(lines, i)) continue;
    return { line: i + 1, text: line };
  }
  return null;
}
function scanSecretLiteralFile(path, content, findings) {
  const secretMatch = findHardcodedSecret(path, content);
  if (!secretMatch) return;
  addFinding(findings, {
    code: REASON_CODES.EXPOSED_SECRET_LITERAL,
    severity: "critical",
    file: path,
    line: secretMatch.line,
    message: "File appears to expose a hardcoded API secret or token.",
    evidence: secretMatch.text
  });
}
function scanPlaintextCgnatEndpointFile(path, content, findings) {
  if (!CGNAT_HTTP_URL_PATTERN.test(content)) return;
  const match = findFirstLine(content, CGNAT_HTTP_URL_PATTERN);
  addFinding(findings, {
    code: REASON_CODES.EXPOSED_RESOURCE_IDENTIFIER,
    severity: "critical",
    file: path,
    line: match.line,
    message: "Plaintext HTTP endpoint targets a CGNAT/Tailscale-range address.",
    evidence: match.text
  });
}
function hasNearbyConfirmationGate(lines, commandIndex) {
  const start = Math.max(0, commandIndex - 8);
  const context = lines.slice(start, commandIndex + 1).join("\n");
  return [
    /\bask\s+(?:the\s+)?user\b.{0,120}\b(?:confirm|confirmation|approve|approval|continue|yes)\b/is,
    /\b(?:prompt\s+for|require|request|obtain)\s+(?:explicit\s+)?(?:user\s+)?(?:confirmation|approval)\b/is,
    /\buser\s+(?:confirmation|approval)\b/is,
    /\bcontinue\?\s*\(?(?:yes\/no|y\/n)\)?/is,
    /\breply\s+["']?yes["']?\b/is,
    /\bonly\s+(?:continue\s+)?after\s+(?:the\s+)?user\b.{0,80}\b(?:confirms?|approves?|answers?\s+yes)\b/is
  ].some((pattern) => pattern.test(context));
}
function findUnguardedDestructiveDelete(content, slug) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!DESTRUCTIVE_DELETE_PATTERN.test(lines[i])) continue;
    if (hasNearbyConfirmationGate(lines, i)) continue;
    if (hasNearbyUninstallCleanupContext(lines, i) && isScopedOpenClawDelete(lines[i] ?? "", slug)) {
      continue;
    }
    return { line: i + 1, text: lines[i] };
  }
  return null;
}
function hasNearbyUninstallCleanupContext(lines, commandIndex) {
  const start = Math.max(0, commandIndex - 10);
  const context = lines.slice(start, commandIndex + 1).join("\n");
  return /(?:^|\n)\s{0,3}#{1,4}\s*(?:uninstall|remove|cleanup|clean up|delete generated files)\b/i.test(
    context
  );
}
function isScopedOpenClawDelete(line, slug) {
  if (!/\.openclaw\//.test(line)) return false;
  if (/\/\.\.(?:\/|$)|\$\(|`/.test(line)) return false;
  if (slug && line.toLowerCase().includes(slug.toLowerCase())) return true;
  if (/\.openclaw\/(?:config|cache|logs|data|tmp|state)\/[^/\s"'`;|&)]+/i.test(line)) {
    return true;
  }
  return false;
}
function addFinding(findings, finding) {
  findings.push({ ...finding, evidence: truncateEvidence(finding.evidence.trim()) });
}
function findFirstLine(content, pattern) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) {
      return { line: i + 1, text: lines[i] };
    }
  }
  return { line: 1, text: lines[0] ?? "" };
}
function findLineAtIndex(content, index) {
  const line = content.slice(0, index).split("\n").length;
  const lineStart = content.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const nextNewline = content.indexOf("\n", index);
  const lineEnd = nextNewline === -1 ? content.length : nextNewline;
  return { line, text: content.slice(lineStart, lineEnd) };
}
function findCallEnd(content, openParenIndex) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let i = openParenIndex; i < content.length; i += 1) {
    const char = content[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = void 0;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return content.length;
}
function isSafeLiteralChildProcessCall(callName, callText) {
  if (!["execFile", "execFileSync", "spawn", "spawnSync"].includes(callName)) return false;
  const match = callText.match(
    /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*(["'])([^"']+)\1\s*,\s*\[/
  );
  if (!match) return false;
  if (/\bshell\s*:\s*true\b/.test(callText)) return false;
  const executable = match[2]?.trim().toLowerCase();
  if (!executable) return false;
  const basename = executable.split(/[\\/]/).at(-1) ?? executable;
  return !/^(?:sh|bash|zsh|fish|cmd|powershell|pwsh)$/.test(basename);
}
function isSafeFixedArgvChildProcessCall(callName, callText, helperContext, helperCallIndex, runtimeFiles, helperFilePath) {
  if (!["execFile", "execFileSync", "spawn", "spawnSync"].includes(callName)) return false;
  if (/\bshell\s*:\s*true\b/.test(callText)) return false;
  if (!new RegExp(String.raw`\b${callName}\s*\(\s*command\s*,\s*args\s*,`).test(callText)) {
    return false;
  }
  const fixedArgvDestructuring = findFixedArgvDestructuring(helperContext);
  return /\brunFixedCommandWithTimeout\b/.test(helperContext) && fixedArgvDestructuring !== null && !mutatesFixedArgvBeforeChildProcessCall(
    helperContext,
    helperCallIndex,
    fixedArgvDestructuring
  ) && /\b(?:timeoutMs|setTimeout)\b/.test(helperContext) && !hasRuntimeReExportOfRunFixedCommandHelper(runtimeFiles, helperFilePath) && hasOnlyFixedRunCommandArgvCallSites(runtimeFiles);
}
function findFixedArgvDestructuring(helperContext) {
  const match = /\bconst\s+\[\s*command\s*,\s*\.\.\.\s*args\s*\]\s*=\s*(params\.argv|argv)/.exec(
    helperContext
  );
  if (match?.index === void 0) return null;
  return {
    source: match[1] ?? "params.argv",
    start: match.index,
    end: match.index + match[0].length
  };
}
function mutatesFixedArgvBeforeChildProcessCall(helperContext, helperCallIndex, fixedArgvDestructuring) {
  if (helperCallIndex < 0 || helperCallIndex > helperContext.length || fixedArgvDestructuring.end > helperCallIndex || fixedArgvDestructuring.start < findInnermostBlockStart(helperContext, helperCallIndex)) {
    return true;
  }
  const beforeDestructuring = helperContext.slice(0, fixedArgvDestructuring.start);
  const betweenDestructuringAndCall = helperContext.slice(
    fixedArgvDestructuring.end,
    helperCallIndex
  );
  const beforeArgvRefs = findFixedArgvMutableReferences(
    beforeDestructuring,
    /* @__PURE__ */ new Set(["params.argv"])
  );
  if (!beforeArgvRefs.has(fixedArgvDestructuring.source)) return true;
  return hasStandaloneAssignment(betweenDestructuringAndCall, "command") || hasFixedArgvMutationInRefs(beforeDestructuring, beforeArgvRefs) || hasFixedArgvMutations(betweenDestructuringAndCall, /* @__PURE__ */ new Set(["args"]));
}
function hasFixedArgvMutations(prefix, initialRefs) {
  const argvRefs = findFixedArgvMutableReferences(prefix, initialRefs);
  return hasFixedArgvMutationInRefs(prefix, argvRefs);
}
function hasFixedArgvMutationInRefs(prefix, argvRefs) {
  return [...argvRefs].some((ref) => hasFixedArgvMutation(prefix, ref));
}
function findFixedArgvMutableReferences(prefix, initialRefs) {
  const refs = new Set(initialRefs);
  if (refs.has("params.argv")) {
    for (const match of prefix.matchAll(
      /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*params\s*(?:[;\n]|$)/g
    )) {
      for (const property of (match[1] ?? "").split(",")) {
        const aliasMatch = property.match(/^\s*argv\s*(?::\s*([A-Za-z_$][\w$]*))?(?:\s*=.+)?\s*$/);
        if (!aliasMatch) continue;
        refs.add(aliasMatch[1] ?? "argv");
      }
    }
  }
  const aliasPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;\n]+)?\s*=\s*([A-Za-z_$][\w$]*|params\.argv)\s*(?:[;\n]|$)/g;
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of prefix.matchAll(aliasPattern)) {
      const [, alias, source] = match;
      if (!alias || !source || refs.has(alias) || !refs.has(source)) continue;
      refs.add(alias);
      changed = true;
    }
  }
  return refs;
}
function hasFixedArgvMutation(prefix, ref) {
  const refPattern = buildFixedArgvReferencePattern(ref);
  return hasStandaloneAssignment(prefix, ref) || new RegExp(String.raw`\bdelete\s+${refPattern}\s*(?:\.|\[)`).test(prefix) || new RegExp(
    String.raw`${refPattern}\s*(?:\[[^\]]+\]|\.\s*[A-Za-z_$][\w$]*)\s*${ASSIGNMENT_OPERATOR_PATTERN}`
  ).test(prefix) || new RegExp(
    String.raw`${refPattern}\s*(?:\?\.\s*|\.\s*)${MUTATING_ARRAY_METHOD_PATTERN}\s*(?:\?\.)?\s*\(`
  ).test(prefix) || new RegExp(
    String.raw`${refPattern}\s*(?:\?\.\s*)?\[\s*["']${MUTATING_ARRAY_METHOD_PATTERN}["']\s*\]\s*(?:\?\.)?\s*\(`
  ).test(prefix) || new RegExp(
    String.raw`\bObject\.(?:assign|defineProperties|defineProperty|setPrototypeOf)\s*\(\s*${refPattern}\s*,`
  ).test(prefix) || new RegExp(
    String.raw`\bReflect\.(?:deleteProperty|set|setPrototypeOf)\s*\(\s*${refPattern}\s*,`
  ).test(prefix) || new RegExp(
    String.raw`\bArray\.prototype\.(?:copyWithin|fill|pop|push|reverse|shift|sort|splice|unshift)\s*\.\s*(?:call|apply)\s*\(\s*${refPattern}\s*,`
  ).test(prefix);
}
function hasStandaloneAssignment(prefix, ref) {
  const assignmentPattern = new RegExp(
    String.raw`${buildFixedArgvReferencePattern(ref)}\s*${ASSIGNMENT_OPERATOR_PATTERN}`,
    "g"
  );
  for (const match of prefix.matchAll(assignmentPattern)) {
    const index = match.index ?? 0;
    if (isDeclarationInitializer(prefix, index)) continue;
    return true;
  }
  return false;
}
var ASSIGNMENT_OPERATOR_PATTERN = String.raw`(?:(?:\|\||&&|\?\?|<<|>>>|>>|\*\*)|[-+*/%&|^])?=(?!=|>)`;
var MUTATING_ARRAY_METHOD_PATTERN = String.raw`(?:copyWithin|fill|pop|push|reverse|shift|sort|splice|unshift)`;
function isDeclarationInitializer(prefix, refIndex) {
  const before = prefix.slice(Math.max(0, refIndex - 120), refIndex);
  return /\b(?:const|let|var)\s*$/.test(before);
}
function buildFixedArgvReferencePattern(ref) {
  return ref === "params.argv" ? String.raw`(?<![\w$.])params\.argv(?![\w$])` : String.raw`(?<![\w$.])${escapeRegExp(ref)}(?![\w$])`;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hasRuntimeReExportOfRunFixedCommandHelper(files, helperFilePath) {
  for (const file of files) {
    if (file.path === helperFilePath) continue;
    if (/\bexport\s*\{[^}]*\brunFixedCommandWithTimeout\b[^}]*\}/.test(file.content)) {
      return true;
    }
    if (/\bexport\s+\*\s+from\s+["'][^"']*(?:deps|run)\.js["']/.test(file.content)) {
      return true;
    }
  }
  return false;
}
function findBlockEnd(content, openBraceIndex) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let i = openBraceIndex; i < content.length; i += 1) {
    const char = content[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = void 0;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return content.length;
}
function findInnermostBlockStart(content, targetIndex) {
  const stack = [];
  let quote;
  let escaped = false;
  for (let i = 0; i < targetIndex; i += 1) {
    const char = content[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = void 0;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") stack.push(i);
    if (char === "}") stack.pop();
  }
  return (stack.at(-1) ?? -1) + 1;
}
function findNamedFunctionContextAtIndex(content, callIndex, functionName) {
  const pattern = new RegExp(String.raw`\bfunction\s+${functionName}\s*\(`, "g");
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    if (start === void 0) continue;
    const openParenIndex = content.indexOf("(", start);
    if (openParenIndex === -1) continue;
    const closeParenIndex = findCallEnd(content, openParenIndex);
    const openBraceIndex = content.indexOf("{", closeParenIndex);
    if (openBraceIndex === -1) continue;
    const end = findBlockEnd(content, openBraceIndex);
    if (callIndex >= openBraceIndex && callIndex < end) {
      return { start, text: content.slice(start, end) };
    }
  }
  return null;
}
function hasOnlyFixedRunCommandArgvCallSites(files) {
  let fixedCallSites = 0;
  for (const file of files) {
    const fileFixedCallSites = countFixedRunCommandArgvCallSites(file.content);
    if (fileFixedCallSites === null) return false;
    fixedCallSites += fileFixedCallSites;
  }
  return fixedCallSites > 0;
}
function countFixedRunCommandArgvCallSites(context) {
  const runnerNames = /* @__PURE__ */ new Set(["runFixedCommandWithTimeout"]);
  for (const match of context.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*\brunFixedCommandWithTimeout\b/g
  )) {
    if (match[1]) runnerNames.add(match[1]);
  }
  for (const match of context.matchAll(
    /\bimport\s*\{[^}]*\brunFixedCommandWithTimeout\s+as\s+([A-Za-z_$][\w$]*)[^}]*\}/g
  )) {
    if (match[1]) runnerNames.add(match[1]);
  }
  for (const match of context.matchAll(
    /\b(?:const|let|var)\s*\{[^}]*\brunFixedCommandWithTimeout\s*:\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*require\(/g
  )) {
    if (match[1]) runnerNames.add(match[1]);
  }
  let fixedCallSites = 0;
  const runnerPattern = new RegExp(String.raw`\b(${Array.from(runnerNames).join("|")})\s*\(`, "g");
  for (const match of context.matchAll(runnerPattern)) {
    const callIndex = match.index;
    if (callIndex === void 0) continue;
    const before = context.slice(Math.max(0, callIndex - 32), callIndex);
    if (/\bfunction\s+$/.test(before)) continue;
    const openParenIndex = context.indexOf("(", callIndex);
    const callEnd = findCallEnd(context, openParenIndex);
    const callText = context.slice(callIndex, callEnd);
    const callScope = context.slice(findInnermostBlockStart(context, callIndex), callIndex);
    if (!hasFixedArgvArrayProperty(callText, callScope)) return null;
    fixedCallSites += 1;
  }
  return fixedCallSites;
}
function findConstAssignment(content, identifier) {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(String.raw`\bconst\s+${escapedIdentifier}\s*=\s*([^\n;]+)`))?.[1];
}
function isKnownFixedArgvIdentifier(identifier, content) {
  const assignment = findConstAssignment(content, identifier)?.trim();
  if (!assignment) return false;
  if (identifier === "nodeExecutable") {
    return /^(?:params\.nodeExecutable\s*\?\?\s*)?process\.execPath$/.test(assignment);
  }
  if (identifier === "scriptPath") {
    return /^resolveFn\(\s*["']@matrix-org\/matrix-sdk-crypto-nodejs\/download-lib\.js["']\s*\)$/.test(
      assignment
    );
  }
  return false;
}
function isFixedArgvItem(item, content) {
  if (/^(["']).*\1$/.test(item)) return true;
  if (item === "process.execPath") return true;
  if (/^[A-Za-z_$][\w$]*$/.test(item)) return isKnownFixedArgvIdentifier(item, content);
  return false;
}
function readQuotedArgvItem(item) {
  const match = item.match(/^(["'])(.*)\1$/);
  return match?.[2];
}
function hasFixedArgvArrayProperty(callText, content) {
  const argvMatch = callText.match(/\bargv\s*:\s*\[([\s\S]*?)\]/);
  const argvItems = argvMatch?.[1];
  if (!argvItems) return false;
  const items = argvItems.split(",").map((item) => item.trim()).filter(Boolean);
  const executable = readQuotedArgvItem(items[0] ?? "")?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (executable && /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh)$/.test(executable)) {
    return false;
  }
  return items.every((item) => isFixedArgvItem(item, content));
}
function findChildProcessNamespaceAliases(content) {
  const aliases = /* @__PURE__ */ new Set();
  const moduleNameIdentifiers = /* @__PURE__ */ new Set();
  for (const match of content.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["'](?:node:)?child_process["']/g
  )) {
    if (match[1]) moduleNameIdentifiers.add(match[1]);
  }
  const patterns = [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["'](?:node:)?child_process["']\s*\)/g,
    /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'](?:node:)?child_process["']/g,
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+["'](?:node:)?child_process["']/g,
    /\bimport\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) aliases.add(match[1]);
    }
  }
  for (const moduleName of moduleNameIdentifiers) {
    const escapedModuleName = escapeRegExp(moduleName);
    for (const match of content.matchAll(
      new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+import|require)\(\s*${escapedModuleName}\s*\)`,
        "g"
      )
    )) {
      if (match[1]) aliases.add(match[1]);
    }
  }
  return aliases;
}
function isChildProcessCallMatch(content, callIndex, namespaceAliases) {
  const previous = content[callIndex - 1];
  if (!previous || !/[\w$.]/.test(previous)) return true;
  if (previous !== ".") return false;
  const prefix = content.slice(Math.max(0, callIndex - 200), callIndex);
  const namespace = prefix.match(/([A-Za-z_$][\w$]*)\??\.$/)?.[1];
  if (namespace && namespaceAliases.has(namespace)) return true;
  return /require\(\s*["'](?:node:)?child_process["']\s*\)\s*\??\.$/.test(prefix) || /import\(\s*["'](?:node:)?child_process["']\s*\)\s*\)?\s*\??\.$/.test(prefix);
}
function findDangerousChildProcessCall(path, content, runtimeFiles) {
  if (!/child_process/.test(content)) return null;
  const namespaceAliases = findChildProcessNamespaceAliases(content);
  const execPattern = /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/g;
  for (const match of content.matchAll(execPattern)) {
    const callName = match[1];
    const callIndex = match.index;
    if (callIndex === void 0 || !callName) continue;
    if (!isChildProcessCallMatch(content, callIndex, namespaceAliases)) continue;
    if (callName === "execFile" || callName === "execFileSync" || callName === "spawn" || callName === "spawnSync") {
      const openParenIndex = content.indexOf("(", callIndex);
      const callEnd = findCallEnd(content, openParenIndex);
      const callText = content.slice(callIndex, callEnd);
      if (isSafeLiteralChildProcessCall(callName, callText)) continue;
      const helperContext = findNamedFunctionContextAtIndex(
        content,
        callIndex,
        "runFixedCommandWithTimeout"
      );
      if (helperContext && isSafeFixedArgvChildProcessCall(
        callName,
        callText,
        helperContext.text,
        callIndex - helperContext.start,
        runtimeFiles,
        path
      )) {
        continue;
      }
    }
    return findLineAtIndex(content, callIndex);
  }
  return null;
}
function findDynamicCodeExecution(content) {
  DYNAMIC_CODE_EXECUTION_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(DYNAMIC_CODE_EXECUTION_PATTERN)) {
    const index = match.index ?? 0;
    const line = findLineAtIndex(content, index);
    if (/\bunsafe-eval\b/i.test(line.text)) continue;
    return line;
  }
  return null;
}
function findShellBase64FileUpload(content) {
  if (!/\bcurl\b/i.test(content) || !/\bbase64\b/i.test(content)) return null;
  if (!SHELL_NETWORK_UPLOAD_PATTERN.test(content)) return null;
  if (!SHELL_BASE64_FILE_READ_PATTERN.test(content)) return null;
  return findFirstLine(content, SHELL_BASE64_FILE_READ_PATTERN);
}
function findPythonBase64FileUpload(content) {
  if (!/base64\.b64encode/i.test(content)) return null;
  if (!PYTHON_NETWORK_UPLOAD_PATTERN.test(content)) return null;
  if (!PYTHON_BASE64_FILE_READ_PATTERN.test(content)) return null;
  return findFirstLine(content, PYTHON_BASE64_FILE_READ_PATTERN);
}
function findJsSensitiveFileNetworkSend(content) {
  if (!JS_FILE_READ_PATTERN.test(content)) return null;
  if (!JS_NETWORK_SEND_PATTERN.test(content)) return null;
  if (SENSITIVE_FILE_READ_CONTEXT_PATTERN.test(content)) {
    return findFirstLine(content, SENSITIVE_FILE_READ_CONTEXT_PATTERN);
  }
  const assignmentPattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+)?(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?(?:readFileSync|readFile)\s*\(([^)]*)\)/g;
  for (const match of content.matchAll(assignmentPattern)) {
    const variableName = match[1] ?? "";
    const readArgument = match[2] ?? "";
    if (!SENSITIVE_LOCAL_VALUE_NAME_PATTERN.test(variableName) && !SENSITIVE_LOCAL_VALUE_NAME_PATTERN.test(readArgument)) {
      continue;
    }
    const afterRead = content.slice((match.index ?? 0) + match[0].length);
    const variableSink = new RegExp(
      String.raw`\b(?:fetch\s*\(|http\.request\s*\(|axios\b)[\s\S]{0,1600}\b${variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`,
      "i"
    );
    if (!variableSink.test(afterRead)) continue;
    return findLineAtIndex(content, match.index ?? 0);
  }
  return null;
}
function findUnsafeAgentControlledFileWrite(content) {
  if (!AGENT_OUTPUT_DIR_ARGUMENT_PATTERN.test(content)) return null;
  if (!FFMPEG_FORCE_OUTPUT_PATTERN.test(content)) return null;
  if (OUTPUT_PATH_GUARD_PATTERN.test(content)) return null;
  return findFirstLine(content, /subprocess\.run\s*\(|["']-y["']|output_path\s*=/);
}
function findUnsafePythonRcloneFilename(content) {
  if (!PYTHON_AGENT_FILENAME_PATTERN.test(content)) return null;
  if (!/\brclone\b/.test(content) || !/subprocess\.run\s*\(/.test(content)) return null;
  if (!PYTHON_RCLONE_FILENAME_SINK_PATTERN.test(content)) return null;
  if (PYTHON_FILENAME_GUARD_PATTERN.test(content)) return null;
  return findFirstLine(
    content,
    /rclone_dir\s*\/\s*filename|f["']\.\/\{filename\}|subprocess\.run\s*\(/
  );
}
function findPythonCredentialPostToEnvUrl(content, declaredEnvNames) {
  if (!PYTHON_CREDENTIAL_ENV_PATTERN.test(content)) return null;
  if (!PYTHON_URL_ENV_PATTERN.test(content)) return null;
  if (!PYTHON_HTTP_POST_PATTERN.test(content)) return null;
  if (!PASSWORD_PAYLOAD_PATTERN.test(content)) return null;
  const referencedEnvNames = collectReferencedEnvNames(content);
  const accessesOnlyDeclaredEnvNames = referencedEnvNames.size > 0 && [...referencedEnvNames].every((name) => declaredEnvNames.has(name));
  if (accessesOnlyDeclaredEnvNames) return null;
  return findFirstLine(content, PYTHON_HTTP_POST_PATTERN);
}
function findAutonomousCredentialEgress(files) {
  const packageText = files.map((file) => file.content).join("\n");
  if (!AUTONOMOUS_AGENT_SCHEDULE_PATTERN.test(packageText)) return null;
  if (!CREDENTIAL_BEARING_AGENT_PATTERN.test(packageText)) return null;
  if (!AUTONOMOUS_ANSWER_EGRESS_PATTERN.test(packageText)) return null;
  for (const file of files) {
    if (!AUTONOMOUS_ANSWER_EGRESS_PATTERN.test(file.content)) continue;
    const match = findFirstLine(file.content, AUTONOMOUS_ANSWER_EGRESS_PATTERN);
    return { file: file.path, line: match.line, text: match.text };
  }
  const fallback = files[0];
  if (!fallback) return null;
  return { file: fallback.path, line: 1, text: fallback.content.split("\n")[0] ?? "" };
}
function findRemoteRecipeExecution(files) {
  const packageText = files.map((file) => file.content).join("\n");
  if (!REMOTE_RECIPE_FETCH_PATTERN.test(packageText)) return null;
  if (!MUTABLE_RECIPE_STORE_PATTERN.test(packageText)) return null;
  if (!TEMPLATED_SUBPROCESS_EXECUTION_PATTERN.test(packageText)) return null;
  for (const file of files) {
    if (!TEMPLATED_SUBPROCESS_EXECUTION_PATTERN.test(file.content)) continue;
    const match = findFirstLine(
      file.content,
      /substitute_params\s*\(|shlex\.split|subprocess\.run/
    );
    return { file: file.path, line: match.line, text: match.text };
  }
  const fallback = files[0];
  if (!fallback) return null;
  return { file: fallback.path, line: 1, text: fallback.content.split("\n")[0] ?? "" };
}
function findHardcodedOperatorBillingEndpoint(content) {
  if (!HARDCODED_OPERATOR_BASE_URL_PATTERN.test(content)) return null;
  if (!OAUTH_CLIENT_SECRET_FLOW_PATTERN.test(content)) return null;
  if (!LIGHTNING_BILLING_FLOW_PATTERN.test(content)) return null;
  if (!OUTBOUND_POST_PATTERN.test(content)) return null;
  return findFirstLine(content, HARDCODED_OPERATOR_BASE_URL_PATTERN);
}
function findConfirmationBypass(content) {
  if (!CONFIRMATION_BYPASS_TRIGGER_PATTERN.test(content)) return null;
  if (!RISK_CONFIRMATION_CONTEXT_PATTERN.test(content)) return null;
  if (!DIRECT_COMMAND_EVAL_PATTERN.test(content)) return null;
  if (!HIGH_RISK_CONTEXT_EVAL_PATTERN.test(content)) return null;
  return findFirstLine(
    content,
    /SAFEXEC_CONTEXT|I understand the risk|OPENCLAW_AGENT_CALL|SAFE_EXEC_AUTO_CONFIRM|eval\s+["']?\$command/
  );
}
function normalizeEnvName(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : void 0;
}
function addDeclaredEnvName(names, value) {
  const normalized = normalizeEnvName(value);
  if (normalized) names.add(normalized);
}
function addDeclaredEnvNamesFromList(names, value) {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry === "string") {
      addDeclaredEnvName(names, entry);
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      addDeclaredEnvName(names, entry.name);
    }
  }
}
function addDeclaredEnvNamesFromRecord(names, record) {
  const requires = record.requires && typeof record.requires === "object" && !Array.isArray(record.requires) ? record.requires : void 0;
  addDeclaredEnvName(names, record.primaryEnv);
  addDeclaredEnvNamesFromList(names, record.envVars);
  addDeclaredEnvNamesFromList(names, record.env);
  addDeclaredEnvNamesFromList(names, requires?.env);
}
function addDeclaredEnvNamesFromManifestBlock(names, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  addDeclaredEnvNamesFromRecord(names, value);
}
function collectDeclaredEnvNames(input) {
  const names = /* @__PURE__ */ new Set();
  const sources = [input.frontmatter, input.metadata];
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const record = source;
    addDeclaredEnvNamesFromRecord(names, record);
    addDeclaredEnvNamesFromManifestBlock(names, record.openclaw);
    addDeclaredEnvNamesFromManifestBlock(names, record.clawdis);
    addDeclaredEnvNamesFromManifestBlock(names, record.clawdbot);
    if (record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)) {
      const metadata = record.metadata;
      addDeclaredEnvNamesFromManifestBlock(names, metadata.openclaw);
      addDeclaredEnvNamesFromManifestBlock(names, metadata.clawdis);
      addDeclaredEnvNamesFromManifestBlock(names, metadata.clawdbot);
    }
  }
  return names;
}
function collectReferencedEnvNames(content) {
  const names = /* @__PURE__ */ new Set();
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /os\.environ(?:\.get)?\s*(?:\[\s*|\(\s*)["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /(?:os\.)?getenv\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      addDeclaredEnvName(names, match[1]);
    }
  }
  return names;
}
function hasBroadEnvAccess(content) {
  return /Object\.(?:keys|values|entries)\s*\(\s*process\.env\s*\)/.test(content) || /process\.env(?!\s*(?:\.|\[))/.test(content) || /process\.env\[\s*[^"'`\]]/.test(content);
}
function envNameLooksCredential(name) {
  return /(?:^|_)(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PAT|PRIVATE_KEY|ACCESS_TOKEN|AUTH_TOKEN|SERVICE_ROLE)(?:_|$)/i.test(
    name
  );
}
function scanCodeFile(path, content, findings, declaredEnvNames, runtimeFiles) {
  if (!CODE_EXTENSION.test(path)) return;
  const dangerousChildProcessCall = findDangerousChildProcessCall(path, content, runtimeFiles);
  if (dangerousChildProcessCall) {
    addFinding(findings, {
      code: REASON_CODES.DANGEROUS_EXEC,
      severity: "critical",
      file: path,
      line: dangerousChildProcessCall.line,
      message: "Shell command execution detected (child_process).",
      evidence: dangerousChildProcessCall.text
    });
  }
  const dynamicCodeExecution = findDynamicCodeExecution(content);
  if (dynamicCodeExecution) {
    addFinding(findings, {
      code: REASON_CODES.DYNAMIC_CODE,
      severity: "critical",
      file: path,
      line: dynamicCodeExecution.line,
      message: "Dynamic code execution detected.",
      evidence: dynamicCodeExecution.text
    });
  }
  const hostPlatformSourcePatch = findHostPlatformSourcePatch(content);
  if (hostPlatformSourcePatch) {
    addFinding(findings, {
      code: REASON_CODES.HOST_PLATFORM_SOURCE_PATCH,
      severity: "critical",
      file: path,
      line: hostPlatformSourcePatch.line,
      message: "Install code patches host platform source and rebuilds without confirmation.",
      evidence: hostPlatformSourcePatch.text
    });
  }
  const unsafeAgentControlledFileWrite = findUnsafeAgentControlledFileWrite(content);
  if (unsafeAgentControlledFileWrite) {
    addFinding(findings, {
      code: REASON_CODES.UNSAFE_FILE_WRITE,
      severity: "critical",
      file: path,
      line: unsafeAgentControlledFileWrite.line,
      message: "Agent-controlled output path is passed to an overwrite-capable subprocess.",
      evidence: unsafeAgentControlledFileWrite.text
    });
  }
  if (INSECURE_TLS_VERIFICATION_PATTERN.test(content)) {
    const match = findFirstLine(content, INSECURE_TLS_VERIFICATION_PATTERN);
    addFinding(findings, {
      code: REASON_CODES.INSECURE_TLS_VERIFICATION,
      severity: "warn",
      file: path,
      line: match.line,
      message: "HTTPS certificate verification is disabled.",
      evidence: match.text
    });
  }
  const unsafePythonRcloneFilename = findUnsafePythonRcloneFilename(content);
  if (unsafePythonRcloneFilename) {
    addFinding(findings, {
      code: REASON_CODES.UNSAFE_FILE_WRITE,
      severity: "critical",
      file: path,
      line: unsafePythonRcloneFilename.line,
      message: "Agent-controlled filename is written and passed to rclone without path validation.",
      evidence: unsafePythonRcloneFilename.text
    });
  }
  const confirmationBypass = findConfirmationBypass(content);
  if (confirmationBypass) {
    addFinding(findings, {
      code: REASON_CODES.CONFIRMATION_BYPASS,
      severity: "critical",
      file: path,
      line: confirmationBypass.line,
      message: "Risky command approval can be bypassed through environment or context signals.",
      evidence: confirmationBypass.text
    });
  }
  if (/stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i.test(content)) {
    const match = findFirstLine(content, /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i);
    addFinding(findings, {
      code: REASON_CODES.CRYPTO_MINING,
      severity: "critical",
      file: path,
      line: match.line,
      message: "Possible crypto mining behavior detected.",
      evidence: match.text
    });
  }
  const wsMatch = content.match(/new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/);
  if (wsMatch) {
    const port = Number.parseInt(wsMatch[1] ?? "", 10);
    if (Number.isFinite(port) && !STANDARD_PORTS.has(port)) {
      const match = findFirstLine(content, /new\s+WebSocket\s*\(/);
      addFinding(findings, {
        code: REASON_CODES.SUSPICIOUS_NETWORK,
        severity: "warn",
        file: path,
        line: match.line,
        message: "WebSocket connection to non-standard port detected.",
        evidence: match.text
      });
    }
  }
  const jsSensitiveFileNetworkSend = findJsSensitiveFileNetworkSend(content);
  if (jsSensitiveFileNetworkSend) {
    addFinding(findings, {
      code: REASON_CODES.EXFILTRATION,
      severity: "warn",
      file: path,
      line: jsSensitiveFileNetworkSend.line,
      message: "Sensitive-looking file read is paired with a network send.",
      evidence: jsSensitiveFileNetworkSend.text
    });
  }
  const shellBase64FileUpload = findShellBase64FileUpload(content);
  if (shellBase64FileUpload) {
    addFinding(findings, {
      code: REASON_CODES.EXFILTRATION,
      severity: "critical",
      file: path,
      line: shellBase64FileUpload.line,
      message: "Shell script base64-encodes a local file and sends it over the network.",
      evidence: shellBase64FileUpload.text
    });
  }
  const pythonBase64FileUpload = findPythonBase64FileUpload(content);
  if (pythonBase64FileUpload) {
    addFinding(findings, {
      code: REASON_CODES.EXFILTRATION,
      severity: "critical",
      file: path,
      line: pythonBase64FileUpload.line,
      message: "Python code base64-encodes a local file and sends it over the network.",
      evidence: pythonBase64FileUpload.text
    });
  }
  const pythonCredentialPost = findPythonCredentialPostToEnvUrl(content, declaredEnvNames);
  if (pythonCredentialPost) {
    addFinding(findings, {
      code: REASON_CODES.CREDENTIAL_HARVEST,
      severity: "critical",
      file: path,
      line: pythonCredentialPost.line,
      message: "Python code POSTs credential environment variables to an environment-controlled URL.",
      evidence: pythonCredentialPost.text
    });
  }
  const hardcodedOperatorBilling = findHardcodedOperatorBillingEndpoint(content);
  if (hardcodedOperatorBilling) {
    addFinding(findings, {
      code: REASON_CODES.HARDCODED_OPERATOR_BILLING,
      severity: "critical",
      file: path,
      line: hardcodedOperatorBilling.line,
      message: "Hardcoded operator endpoint combines OAuth credentials with Lightning billing calls.",
      evidence: hardcodedOperatorBilling.text
    });
  }
  const hasProcessEnv = /process\.env/.test(content);
  if (hasProcessEnv && JS_NETWORK_SEND_PATTERN.test(content)) {
    const referencedEnvNames = collectReferencedEnvNames(content);
    const referencesCredentialEnvName = [...referencedEnvNames].some(envNameLooksCredential);
    const accessesOnlyDeclaredEnvNames = referencedEnvNames.size > 0 && [...referencedEnvNames].every((name) => declaredEnvNames.has(name)) && !hasBroadEnvAccess(content);
    if (!accessesOnlyDeclaredEnvNames && (hasBroadEnvAccess(content) || referencesCredentialEnvName)) {
      const match = findFirstLine(content, /process\.env/);
      addFinding(findings, {
        code: REASON_CODES.CREDENTIAL_HARVEST,
        severity: "critical",
        file: path,
        line: match.line,
        message: "Environment variable access combined with network send.",
        evidence: match.text
      });
    }
  }
  if (/(\\x[0-9a-fA-F]{2}){6,}/.test(content) || /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/.test(content)) {
    const match = findFirstLine(content, /(\\x[0-9a-fA-F]{2}){6,}|(?:atob|Buffer\.from)\s*\(/);
    addFinding(findings, {
      code: REASON_CODES.OBFUSCATED_CODE,
      severity: "warn",
      file: path,
      line: match.line,
      message: "Potential obfuscated payload detected.",
      evidence: match.text
    });
  }
}
function scanMarkdownFile(path, content, findings, slug) {
  if (!MARKDOWN_EXTENSION.test(path)) return;
  const credentialExposure = findCredentialExposureInstruction(content);
  if (credentialExposure) {
    addFinding(findings, {
      code: REASON_CODES.CREDENTIAL_EXPOSURE_INSTRUCTIONS,
      severity: "critical",
      file: path,
      line: credentialExposure.line,
      message: "Instructions expose credentials through shell, git config, or agent memory.",
      evidence: credentialExposure.text
    });
  }
  const secretArgvExposure = findSecretArgvExposure(content);
  if (secretArgvExposure) {
    addFinding(findings, {
      code: REASON_CODES.SECRET_ARGV_EXPOSURE,
      severity: "critical",
      file: path,
      line: secretArgvExposure.line,
      message: "Instructions pass high-value credentials through process argv.",
      evidence: secretArgvExposure.text
    });
  }
  const hardcodedOperatorBilling = findHardcodedOperatorBillingEndpoint(content);
  if (hardcodedOperatorBilling) {
    addFinding(findings, {
      code: REASON_CODES.HARDCODED_OPERATOR_BILLING,
      severity: "critical",
      file: path,
      line: hardcodedOperatorBilling.line,
      message: "Hardcoded operator endpoint combines OAuth credentials with Lightning billing calls.",
      evidence: hardcodedOperatorBilling.text
    });
  }
  if (hasMaliciousInstallPrompt(content)) {
    const match = findFirstLine(
      content,
      /installer-package\s*:|base64\s+-?[dD]|(?:curl|wget)\b|run\s+it\s+in\s+terminal/i
    );
    addFinding(findings, {
      code: REASON_CODES.MALICIOUS_INSTALL_PROMPT,
      severity: "critical",
      file: path,
      line: match.line,
      message: "Install prompt contains an obfuscated terminal payload.",
      evidence: match.text
    });
  }
  const destructiveDelete = findUnguardedDestructiveDelete(content, slug);
  if (destructiveDelete) {
    addFinding(findings, {
      code: REASON_CODES.DESTRUCTIVE_DELETE_COMMAND,
      severity: "warn",
      file: path,
      line: destructiveDelete.line,
      message: "Documentation contains a destructive delete command without an explicit confirmation gate.",
      evidence: destructiveDelete.text
    });
  }
  if (/ignore\s+(all\s+)?previous\s+instructions/i.test(content) || /system\s*prompt\s*[:=]/i.test(content)) {
    const match = findFirstLine(
      content,
      /ignore\s+(all\s+)?previous\s+instructions|system\s*prompt\s*[:=]/i
    );
    addFinding(findings, {
      code: REASON_CODES.INJECTION_INSTRUCTIONS,
      severity: "warn",
      file: path,
      line: match.line,
      message: "Prompt-injection style instruction pattern detected.",
      evidence: match.text
    });
  }
  if (GENERATED_SOURCE_PLACEHOLDER_PATTERN.test(content) && GENERATED_SOURCE_CONTEXT_PATTERN.test(content)) {
    const match = findFirstLine(content, GENERATED_SOURCE_PLACEHOLDER_PATTERN);
    addFinding(findings, {
      code: REASON_CODES.GENERATED_SOURCE_TEMPLATE,
      severity: "critical",
      file: path,
      line: match.line,
      message: "User-controlled placeholder is embedded directly into generated source code.",
      evidence: match.text
    });
  }
  if (HARDCODED_CONNECTION_ID_PATTERN.test(content)) {
    const match = findFirstLine(content, HARDCODED_CONNECTION_ID_PATTERN);
    addFinding(findings, {
      code: REASON_CODES.EXPOSED_RESOURCE_IDENTIFIER,
      severity: "critical",
      file: path,
      line: match.line,
      message: "Example code exposes a concrete connection_id instead of a placeholder.",
      evidence: match.text
    });
  }
  const spreadsheetUrlPattern = new RegExp(
    GOOGLE_SHEETS_SPREADSHEET_URL_PATTERN.source,
    `${GOOGLE_SHEETS_SPREADSHEET_URL_PATTERN.flags.replaceAll("g", "")}g`
  );
  for (const spreadsheetUrlMatch of content.matchAll(spreadsheetUrlPattern)) {
    const spreadsheetId = spreadsheetUrlMatch[1];
    if (!spreadsheetId || looksLikePlaceholderIdentifier(spreadsheetId)) continue;
    const match = findLineAtIndex(content, spreadsheetUrlMatch.index ?? 0);
    addFinding(findings, {
      code: REASON_CODES.EXPOSED_RESOURCE_IDENTIFIER,
      severity: "critical",
      file: path,
      line: match.line,
      message: "Example code exposes a concrete Google Sheets spreadsheet ID instead of a placeholder.",
      evidence: match.text
    });
    break;
  }
}
function scanManifestFile(path, content, findings) {
  if (!MANIFEST_EXTENSION.test(path)) return;
  if (/https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\//i.test(content) || RAW_IP_URL_PATTERN.test(content)) {
    const match = findFirstLine(
      content,
      /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\/|https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i
    );
    addFinding(findings, {
      code: REASON_CODES.SUSPICIOUS_INSTALL_SOURCE,
      severity: "warn",
      file: path,
      line: match.line,
      message: "Install source points to URL shortener or raw IP.",
      evidence: match.text
    });
  }
}
function normalizedSeverityRank(severity) {
  switch (severity?.trim().toLowerCase()) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}
function highestLlmConcernSeverityRank(analysis) {
  let rank = 0;
  for (const finding of analysis?.agenticRiskFindings ?? []) {
    if (finding.status !== "concern") continue;
    rank = Math.max(rank, normalizedSeverityRank(finding.severity));
  }
  for (const bucket of Object.values(analysis?.riskSummary ?? {})) {
    if (bucket?.status !== "concern") continue;
    rank = Math.max(rank, normalizedSeverityRank(bucket.highestSeverity));
  }
  return rank;
}
function addLlmStatusReason(reasonCodes, status, analysis) {
  const normalized = status?.trim().toLowerCase();
  if (normalized === "malicious") {
    reasonCodes.push("malicious.llm_malicious");
    return;
  }
  if (normalized !== "suspicious") return;
  const concernRank = highestLlmConcernSeverityRank(analysis);
  if (concernRank >= normalizedSeverityRank("high")) {
    reasonCodes.push("suspicious.llm_suspicious");
  } else {
    reasonCodes.push(REASON_CODES.LLM_REVIEW);
  }
}
function completedCodexStatus(status, analysis) {
  const normalized = status?.trim().toLowerCase();
  if (normalized === "clean" || normalized === "suspicious" || normalized === "malicious") {
    return normalized;
  }
  const verdict = analysis?.verdict?.trim().toLowerCase();
  if (verdict === "benign") return "clean";
  if (verdict === "suspicious" || verdict === "malicious") return verdict;
  return void 0;
}
function runStaticModerationScan(input) {
  const findings = [];
  const files = [...input.fileContents].sort((a, b) => a.path.localeCompare(b.path));
  const runtimeFiles = files.filter((file) => !isTestFixtureFile(file.path));
  const declaredEnvNames = collectDeclaredEnvNames(input);
  for (const file of files) {
    scanSecretLiteralFile(file.path, file.content, findings);
    scanPlaintextCgnatEndpointFile(file.path, file.content, findings);
    scanCodeFile(file.path, file.content, findings, declaredEnvNames, runtimeFiles);
    scanMarkdownFile(file.path, file.content, findings, input.slug);
    scanManifestFile(file.path, file.content, findings);
  }
  const autonomousCredentialEgress = findAutonomousCredentialEgress(files);
  if (autonomousCredentialEgress) {
    addFinding(findings, {
      code: REASON_CODES.AUTONOMOUS_CREDENTIAL_EGRESS,
      severity: "critical",
      file: autonomousCredentialEgress.file,
      line: autonomousCredentialEgress.line,
      message: "Autonomous schedule or loop submits credential-bearing agent output without per-call consent.",
      evidence: autonomousCredentialEgress.text
    });
  }
  const remoteRecipeExecution = findRemoteRecipeExecution(files);
  if (remoteRecipeExecution) {
    addFinding(findings, {
      code: REASON_CODES.REMOTE_RECIPE_EXECUTION,
      severity: "critical",
      file: remoteRecipeExecution.file,
      line: remoteRecipeExecution.line,
      message: "Remote recipe/catalog data can influence templated subprocess command execution.",
      evidence: remoteRecipeExecution.text
    });
  }
  const installJson = JSON.stringify(input.metadata ?? {});
  if (/https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\//i.test(installJson)) {
    addFinding(findings, {
      code: REASON_CODES.SUSPICIOUS_INSTALL_SOURCE,
      severity: "warn",
      file: "metadata",
      line: 1,
      message: "Install metadata references shortener URL.",
      evidence: installJson
    });
  }
  const alwaysValue = input.frontmatter.always;
  if (alwaysValue === true || alwaysValue === "true") {
    addFinding(findings, {
      code: REASON_CODES.MANIFEST_PRIVILEGED_ALWAYS,
      severity: "warn",
      file: "SKILL.md",
      line: 1,
      message: "Skill is configured with always=true (persistent invocation).",
      evidence: "always: true"
    });
  }
  const identityText = `${input.slug}
${input.displayName}
${input.summary ?? ""}`;
  if (/keepcold131\/ClawdAuthenticatorTool|ClawdAuthenticatorTool/i.test(identityText)) {
    addFinding(findings, {
      code: REASON_CODES.KNOWN_BLOCKED_SIGNATURE,
      severity: "critical",
      file: "metadata",
      line: 1,
      message: "Matched a known blocked malware signature.",
      evidence: identityText
    });
  }
  findings.sort(
    (a, b) => `${a.code}:${a.file}:${a.line}:${a.message}`.localeCompare(
      `${b.code}:${b.file}:${b.line}:${b.message}`
    )
  );
  const reasonCodes = normalizeReasonCodes(findings.map((finding) => finding.code));
  const status = verdictFromCodes(reasonCodes);
  return {
    status,
    reasonCodes,
    findings,
    summary: summarizeReasonCodes(reasonCodes),
    engineVersion: MODERATION_ENGINE_VERSION,
    checkedAt: Date.now()
  };
}
function buildModerationSnapshot(params) {
  const llmStatus = params.llmStatus ?? params.llmAnalysis?.status;
  const codexStatus = completedCodexStatus(llmStatus, params.llmAnalysis);
  const reasonCodes = [];
  addLlmStatusReason(reasonCodes, codexStatus, params.llmAnalysis);
  const normalizedCodes = normalizeReasonCodes(reasonCodes);
  const verdict = verdictFromCodes(normalizedCodes);
  return {
    verdict,
    reasonCodes: normalizedCodes,
    evidence: [],
    summary: summarizeReasonCodes(normalizedCodes),
    engineVersion: MODERATION_ENGINE_VERSION,
    evaluatedAt: Date.now(),
    sourceVersionId: params.sourceVersionId,
    legacyFlags: legacyFlagsFromVerdict(verdict)
  };
}
function resolveSkillVerdict(skill) {
  if (skill.moderationVerdict) return skill.moderationVerdict;
  if (skill.moderationFlags?.includes("blocked.malware")) return "malicious";
  if (skill.moderationFlags?.includes("flagged.suspicious")) return "suspicious";
  if (skill.moderationReason?.startsWith("scanner.") && skill.moderationReason.endsWith(".malicious")) {
    return "malicious";
  }
  if (skill.moderationReason?.startsWith("scanner.") && skill.moderationReason.endsWith(".suspicious")) {
    return "suspicious";
  }
  if ((skill.moderationReasonCodes ?? []).some((code) => code.startsWith("malicious."))) {
    return "malicious";
  }
  if ((skill.moderationReasonCodes ?? []).some((code) => code.startsWith("suspicious."))) {
    return "suspicious";
  }
  return "clean";
}
export {
  buildModerationSnapshot,
  resolveSkillVerdict,
  runStaticModerationScan
};
