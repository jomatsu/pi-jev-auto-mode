import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_SETTINGS, JevAutoModeStore, parseSettingsPatch } from "../src/settings.ts";

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
