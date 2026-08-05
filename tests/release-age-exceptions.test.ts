import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSecurityExceptions } from "../scripts/check-release-age-exceptions.mjs";

const exception = (packageSpec = "hono@4.12.34", expires = "2026-08-05T02:36:40.543Z") => `
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  # security-exception advisory=GHSA-8j4g-w8fx-2239 published=2026-08-03T02:36:40.543Z quarantineEnds=2026-08-04T02:36:40.543Z expires=${expires}
  - ${packageSpec}
`;

describe("release-age security exceptions", () => {
  it("accepts a documented exact-version exception before its deadline", () => {
    const exceptions = validateSecurityExceptions(exception(), new Date("2026-08-04T12:00:00Z"));
    assert.equal(exceptions[0]?.package, "hono@4.12.34");
  });

  it("rejects a range that could bypass quarantine for later releases", () => {
    assert.throws(
      () => validateSecurityExceptions(exception("hono@^4.12.34"), new Date("2026-08-04T12:00:00Z")),
      /not an exact package@version/,
    );
  });

  it("rejects an expired exception so it cannot become permanent", () => {
    assert.throws(
      () => validateSecurityExceptions(exception(), new Date("2026-08-05T02:36:40.543Z")),
      /expired at/,
    );
  });

  it("rejects a quarantine interval shorter than the repository policy", () => {
    const source = exception().replace("2026-08-04T02:36:40.543Z", "2026-08-03T03:36:40.543Z");
    assert.throws(
      () => validateSecurityExceptions(source, new Date("2026-08-03T03:00:00Z")),
      /24-hour quarantine/,
    );
  });

  it("rejects removal or reduction of the repository-wide quarantine", () => {
    assert.throws(
      () => validateSecurityExceptions(exception().replace("minimumReleaseAge: 1440", "minimumReleaseAge: 60")),
      /preserve the 24-hour minimumReleaseAge: 1440 policy/,
    );
    assert.throws(
      () => validateSecurityExceptions(exception().replace("minimumReleaseAge: 1440\n", "")),
      /preserve the 24-hour minimumReleaseAge: 1440 policy/,
    );
  });
});
