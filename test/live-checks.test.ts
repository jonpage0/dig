import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeActionArgs } from "../src/core/plugin.ts";
import { SOURCES, actionByName } from "../src/sources/index.ts";
import { CHECKS, EXPENSIVE, SKIPPED } from "./live/checks.mjs";

const ALL_ACTION_NAMES = SOURCES.flatMap((s) => s.actions.map((a) => a.name));

test("every provider action has exactly one live check or a stated reason it is skipped, and no unknown action is named", () => {
  const named = [...CHECKS, ...SKIPPED].map((entry) => entry.tool);
  for (const name of ALL_ACTION_NAMES) {
    assert.equal(
      named.filter((entry) => entry === name).length,
      1,
      `${name} must appear once in CHECKS or SKIPPED`,
    );
  }
  for (const name of [...named, ...EXPENSIVE]) {
    assert.ok(actionByName(name), `${name} is not a registered Dig 2.0 action`);
  }
  for (const name of EXPENSIVE) {
    assert.ok(
      CHECKS.some((check) => check.tool === name),
      `${name} is expensive but has no check`,
    );
  }
  for (const { tool, reason } of SKIPPED) {
    assert.ok(reason?.trim(), `${tool} is skipped without a reason`);
  }
  for (const check of CHECKS) {
    if (check.replay === false) {
      assert.ok(check.replayNote?.trim(), `${check.tool} cannot replay but says not why`);
    }
  }
});

test("every live check sends arguments its action Effect Schema accepts, without project or dig", () => {
  for (const { tool, args } of CHECKS) {
    assert.ok(!("project" in args) && !("dig" in args), `${tool}: the script adds dig/project`);
    const entry = actionByName(tool);
    assert.ok(entry, `missing action ${tool}`);
    const decoded = decodeActionArgs(entry.action, args);
    assert.equal(decoded.ok, true, `${tool}: ${decoded.ok ? "" : decoded.error}`);
  }
});
