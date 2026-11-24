import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { schemaToMcpJson } from "../core/plugin.ts";
import { ACCOUNTS, ALL_SOURCE_IDS, CATALOG_META, SOURCE_GROUPS, SOURCES, actionByName, sourceById } from "./index.ts";

describe("Dig 2.0 Source Registry (src/sources/index.ts)", () => {
  it("registers all 29 sources/tools with unique IDs and zero perplexity", () => {
    assert.equal(SOURCES.length, 29);
    assert.equal(new Set(ALL_SOURCE_IDS).size, 29);
    assert.equal(sourceById("perplexity"), undefined);
    assert.equal(ACCOUNTS.find((a) => a.id === "perplexity"), undefined);
  });

  it("maps every source to exactly one SOURCE_GROUPS entry matching plugin.group", () => {
    const grouped = SOURCE_GROUPS.flatMap((g) => g.sources);
    assert.equal(grouped.length, SOURCES.length);
    assert.equal(new Set(grouped).size, SOURCES.length);
    for (const g of SOURCE_GROUPS) {
      for (const id of g.sources) {
        const plugin = sourceById(id);
        assert.ok(plugin, `Missing plugin for group entry ${id}`);
        assert.equal(plugin.group, g.id, `Plugin ${id} group mismatch`);
      }
    }
  });

  it("exposes unique action names and valid compact JSON schemas across all actions", () => {
    const seen = new Set<string>();
    for (const source of SOURCES) {
      assert.ok(source.actions.length > 0, `Source ${source.id} must define at least one action`);
      for (const action of source.actions) {
        assert.ok(!seen.has(action.name), `Duplicate action name: ${action.name}`);
        seen.add(action.name);
        assert.equal(actionByName(action.name)?.source.id, source.id);
        const json = schemaToMcpJson(action.schema, { compact: true }) as Record<string, unknown>;
        assert.equal(json.type, "object", `Action ${action.name} compact schema must be an object`);
      }
    }
    assert.ok(seen.size >= 60, `Expected >= 60 actions, found ${seen.size}`);
  });

  it("covers every required source key in ACCOUNTS and registers credential env names", () => {
    const accountKeys = new Set(
      ACCOUNTS.flatMap((a) => [...a.keys.flat(), ...(a.optional ?? [])]),
    );
    for (const key of CATALOG_META.requiredKeyNames) {
      assert.ok(accountKeys.has(key), `Required key ${key} missing from ACCOUNTS`);
    }
  });
});
