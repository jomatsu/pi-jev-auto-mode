import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

  it("defaults to judging everything the deterministic layer cannot vouch for", () => {
    assert.equal(DEFAULT_SETTINGS.provider, "typesafe");
    assert.equal(DEFAULT_SETTINGS.gateScope, "all");
    assert.equal(parseSettingsPatch({ gateScope: "matched" }).gateScope, "matched");
    assert.equal(parseSettingsPatch({ gateScope: "all" }).gateScope, "all");
    assert.equal(parseSettingsPatch({ gateScope: "sometimes" }).gateScope, undefined);
  });

  it("accepts only supported providers and does not trust malformed overrides", () => {
    assert.equal(parseSettingsPatch({ provider: "openrouter" }).provider, "openrouter");
    assert.equal(parseSettingsPatch({ provider: "other" }).provider, undefined);
    assert.equal(parseSettingsPatch({ provider: null }).provider, undefined);
  });

  it("accepts only known uncertain actions", () => {
    assert.equal(parseSettingsPatch({ uncertain: "deny" }).uncertain, "deny");
    assert.equal(parseSettingsPatch({ uncertain: "ask" }).uncertain, "ask");
    assert.equal(parseSettingsPatch({ uncertain: "allow" }).uncertain, "allow");
    assert.equal(parseSettingsPatch({ uncertain: "maybe" }).uncertain, undefined);
    assert.equal(parseSettingsPatch({ uncertain: true }).uncertain, undefined);
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
  it("defaults to passing an unclear answer rather than blocking it", () => {
    assert.equal(DEFAULT_SETTINGS.uncertain, "allow");
  });

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

describe("provider-specific credentials", () => {
  it("keeps OpenRouter and TypeSafe credentials separate", async () => {
    const dir = await tempDir();
    const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });
    await store.writeStoredApiKey("typesafe-secret");
    await store.writeStoredApiKey("openrouter-secret", "openrouter");
    assert.notEqual(store.credentialPath(), store.credentialPath("openrouter"));
    assert.equal(await store.readStoredApiKey("openrouter"), "openrouter-secret");
    assert.equal(await store.readStoredApiKey(), "typesafe-secret");
    await store.deleteStoredApiKey("openrouter");
    assert.equal(await store.readStoredApiKey("openrouter"), undefined);
    assert.equal(await store.readStoredApiKey(), "typesafe-secret");
  });
});

describe("stored API key", () => {
  it("keeps the secret out of the settings file and owner-readable only", async () => {
    const dir = await tempDir();
    const agentDir = join(dir, "agent");
    const store = new JevAutoModeStore({ agentDir, configDirName: ".pi" });

    await store.saveSettings({ ...DEFAULT_SETTINGS, enabled: true }, "global", join(dir, "project"));
    await store.writeStoredApiKey("apikey_secret");

    const settings = await readFile(store.globalSettingsPath(), "utf8");
    assert.equal(settings.includes("apikey_secret"), false, "the settings file must not carry the key");

    if (process.platform !== "win32") {
      // chmod is not meaningful on Windows, so the modes are asserted where they exist.
      assert.equal((await stat(store.credentialPath())).mode & 0o777, 0o600);
      assert.equal((await stat(join(agentDir, "secrets"))).mode & 0o777, 0o700);
    }
  });

  it("tightens permissions on an existing file", { skip: process.platform === "win32" }, async () => {
    const dir = await tempDir();
    const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });

    await store.writeStoredApiKey("first");
    await chmod(store.credentialPath(), 0o644);
    await store.writeStoredApiKey("second");

    assert.equal((await stat(store.credentialPath())).mode & 0o777, 0o600);
    assert.equal(await store.readStoredApiKey(), "second");
  });

  it("reads nothing when absent or empty, and deletes what it wrote", async () => {
    const dir = await tempDir();
    const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });

    assert.equal(await store.readStoredApiKey(), undefined);
    await store.writeStoredApiKey("   ");
    assert.equal(await store.readStoredApiKey(), undefined);

    await store.writeStoredApiKey("apikey_x");
    await store.deleteStoredApiKey();
    assert.equal(await store.readStoredApiKey(), undefined);
    await store.deleteStoredApiKey(); // idempotent
  });
});

describe("display setting", () => {
  it("defaults to compact and accepts only known modes", () => {
    assert.equal(DEFAULT_SETTINGS.display, "compact");
    assert.equal(parseSettingsPatch({ display: "compact" }).display, "compact");
    assert.equal(parseSettingsPatch({ display: "full" }).display, "full");
    assert.equal(parseSettingsPatch({ display: "tiny" }).display, undefined);
  });
});
