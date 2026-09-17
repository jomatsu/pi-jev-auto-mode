import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_SETTINGS, JevAutoModeStore, mergeSettings, parseSettingsPatch, parseThreshold } from "../src/settings.ts";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-auto-mode-"));
  temps.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseSettingsPatch", () => {
  it("drops malformed values instead of throwing", () => {
    const patch = parseSettingsPatch({
      enabled: "yes",
      timeoutMs: -5,
      maxRetries: 99,
      allowedCommands: ["ok", 42, ""],
      extraProtectedPaths: "nope",
      unknown: true,
    });
    assert.deepEqual(patch, { allowedCommands: ["ok"] });
  });

  it("ignores non-object input", () => {
    assert.deepEqual(parseSettingsPatch("nope"), {});
    assert.deepEqual(parseSettingsPatch([1, 2]), {});
    assert.deepEqual(parseSettingsPatch(null), {});
  });
});

describe("parseThreshold", () => {
  it("accepts only values that leave a middle band on both sides", () => {
    assert.equal(parseThreshold(0.8), 0.8);
    assert.equal(parseThreshold(1), 1);
    assert.equal(parseThreshold(0.5), undefined);
    assert.equal(parseThreshold(0.4), undefined);
    assert.equal(parseThreshold(1.01), undefined);
    assert.equal(parseThreshold("0.8"), undefined);
    assert.equal(parseThreshold(Number.NaN), undefined);
  });
});

describe("threshold settings", () => {
  it("keeps only usable entries", () => {
    const patch = parseSettingsPatch({
      thresholds: { intent_coverage: 0.6, local_scope: 0.4, broken: "nope", "": 0.9 },
    });
    assert.deepEqual(patch.thresholds, { intent_coverage: 0.6 });
  });

  it("merges per rule so one override does not wipe the others", () => {
    const merged = mergeSettings(
      { ...DEFAULT_SETTINGS, thresholds: { intent_coverage: 0.6, local_scope: 0.95 } },
      { thresholds: { local_scope: 0.99 } },
    );
    assert.deepEqual(merged.thresholds, { intent_coverage: 0.6, local_scope: 0.99 });
  });

  it("survives a save and load round trip", async () => {
    const dir = await tempDir();
    const cwd = join(dir, "project");
    const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });

    await store.saveSettings({ ...DEFAULT_SETTINGS, thresholds: { no_secret_egress: 0.995 } }, "global", cwd);
    const loaded = await store.loadSettings(cwd, true);
    assert.deepEqual(loaded.settings.thresholds, { no_secret_egress: 0.995 });
  });
});

describe("JevAutoModeStore", () => {
  it("starts from the defaults when nothing is configured", async () => {
    const dir = await tempDir();
    const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });
    const loaded = await store.loadSettings(join(dir, "project"), true);
    assert.equal(loaded.settings.enabled, DEFAULT_SETTINGS.enabled);
    assert.equal(loaded.scope, "global");
  });

  it("layers a trusted project override on top of the global settings", async () => {
    const dir = await tempDir();
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "project");
    const store = new JevAutoModeStore({ agentDir, configDirName: ".pi" });

    await store.saveSettings({ ...DEFAULT_SETTINGS, timeoutMs: 9000 }, "global", cwd);
    await store.saveSettings({ ...DEFAULT_SETTINGS, timeoutMs: 1500, allowedCommands: ["ls*"] }, "project", cwd);

    const loaded = await store.loadSettings(cwd, true);
    assert.equal(loaded.settings.timeoutMs, 1500);
    assert.deepEqual(loaded.settings.allowedCommands, ["ls*"]);
    assert.equal(loaded.scope, "project");
  });

  it("ignores a project override when the project is not trusted", async () => {
    const dir = await tempDir();
    const cwd = join(dir, "project");
    const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });

    await store.saveSettings({ ...DEFAULT_SETTINGS, enabled: false }, "project", cwd);

    const loaded = await store.loadSettings(cwd, false);
    assert.equal(loaded.settings.enabled, true);
    assert.equal(loaded.scope, "global");
  });

  it("round-trips policy notes and caps their length", async () => {
    const dir = await tempDir();
    const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });

    await store.savePolicyNotes("prefer mise over global installs");
    assert.equal(await store.loadPolicyNotes(), "prefer mise over global installs");

    await store.savePolicyNotes("x".repeat(20_000));
    assert.equal((await store.loadPolicyNotes()).length, 8000);
  });
});
