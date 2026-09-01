import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateReleaseAgeExceptions } from "../scripts/check-release-age-exceptions.mjs";
import {
  collectPublishedPackages,
  findTooNewPackages,
} from "../scripts/check-npm-shrinkwrap-release-age.mjs";

const exception = (packageSpec = "hono@4.12.34", expires = "2026-08-05T02:36:40.543Z") => `
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  # security-exception advisory=GHSA-8j4g-w8fx-2239 published=2026-08-03T02:36:40.543Z quarantineEnds=2026-08-04T02:36:40.543Z expires=${expires}
  - ${packageSpec}
`;

const releaseException = (reason = "openclaw-compatibility") => `
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  # release-exception reason=${reason} published=2026-09-01T16:19:50.535Z quarantineEnds=2026-09-02T16:19:50.535Z expires=2026-09-03T16:19:50.535Z
  - openclaw@2026.8.2
`;

describe("release-age exceptions", () => {
  it("accepts a documented exact-version exception before its deadline", () => {
    const exceptions = validateReleaseAgeExceptions(exception(), new Date("2026-08-04T12:00:00Z"));
    assert.equal(exceptions[0]?.package, "hono@4.12.34");
  });

  it("accepts an explicit documented release exception without weakening the global policy", () => {
    const exceptions = validateReleaseAgeExceptions(releaseException(), new Date("2026-09-01T20:00:00Z"));
    assert.equal(exceptions[0]?.kind, "release-exception");
    assert.equal(exceptions[0]?.reason, "openclaw-compatibility");
    assert.equal(exceptions[0]?.package, "openclaw@2026.8.2");
  });

  it("rejects an undocumented release exception", () => {
    assert.throws(
      () => validateReleaseAgeExceptions(releaseException(""), new Date("2026-09-01T20:00:00Z")),
      /machine-readable reason/,
    );
  });

  it("rejects a range that could bypass quarantine for later releases", () => {
    assert.throws(
      () => validateReleaseAgeExceptions(exception("hono@^4.12.34"), new Date("2026-08-04T12:00:00Z")),
      /not an exact package@version/,
    );
  });

  it("rejects an expired exception so it cannot become permanent", () => {
    assert.throws(
      () => validateReleaseAgeExceptions(exception(), new Date("2026-08-05T02:36:40.543Z")),
      /expired at/,
    );
  });

  it("rejects a quarantine interval shorter than the repository policy", () => {
    const source = exception().replace("2026-08-04T02:36:40.543Z", "2026-08-03T03:36:40.543Z");
    assert.throws(
      () => validateReleaseAgeExceptions(source, new Date("2026-08-03T03:00:00Z")),
      /24-hour quarantine/,
    );
  });

  it("rejects removal or reduction of the repository-wide quarantine", () => {
    assert.throws(
      () => validateReleaseAgeExceptions(exception().replace("minimumReleaseAge: 1440", "minimumReleaseAge: 60")),
      /preserve the 24-hour minimumReleaseAge: 1440 policy/,
    );
    assert.throws(
      () => validateReleaseAgeExceptions(exception().replace("minimumReleaseAge: 1440\n", "")),
      /preserve the 24-hour minimumReleaseAge: 1440 policy/,
    );
  });

  it("rejects exclusions that are not covered by an auditable expiring marker", () => {
    assert.throws(
      () =>
        validateReleaseAgeExceptions(
          "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - hono@4.12.34\n",
        ),
      /unannotated exception/u,
    );
  });

  it("checks every shrinkwrapped package version against the same 24-hour window", async () => {
    const packages = collectPublishedPackages({
      packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/aged": { version: "1.0.0" },
        "node_modules/parent/node_modules/@scope/fresh": { version: "2.0.0" },
      },
    });
    const publicationTimes: Record<string, Record<string, string>> = {
      aged: { "1.0.0": "2026-08-01T00:00:00.000Z" },
      "@scope/fresh": { "2.0.0": "2026-08-04T18:00:00.000Z" },
    };
    const tooNew = await findTooNewPackages({
      packages,
      now: new Date("2026-08-05T00:00:00.000Z"),
      fetchImpl: async (url: string) => {
        const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        return {
          ok: true,
          json: async () => ({ time: publicationTimes[name] }),
        } as Response;
      },
    });

    assert.deepEqual(tooNew, [
      { package: "@scope/fresh@2.0.0", published: "2026-08-04T18:00:00.000Z" },
    ]);
  });
});
