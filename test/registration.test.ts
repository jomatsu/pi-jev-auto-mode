import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTO_MODE_COMMAND, AUTO_MODE_FLAG, register, type GateUi } from "../src/extension.ts";
import { DECISION_ENTRY_TYPE } from "../src/records.ts";
import { DEFAULT_SETTINGS, JevAutoModeStore } from "../src/settings.ts";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-auto-mode-register-"));
  temps.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

interface FakePi {
  readonly api: ExtensionAPI;
  readonly flags: Map<string, unknown>;
  readonly commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  readonly handlers: Map<string, Handler[]>;
  readonly entries: Array<{ customType: string; data?: unknown }>;
  readonly notifications: Array<{ message: string; type?: string }>;
  readonly statuses: string[];
}

function createFakePi(): FakePi {
  const flags = new Map<string, unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Handler[]>();
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: string[] = [];

  const fake = {
    registerFlag: (name: string, options: { default?: unknown }) => {
      flags.set(name, options.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
    registerEntryRenderer: () => {},
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
  };

  return {
    api: fake as unknown as ExtensionAPI,
    flags,
    commands,
    handlers,
    entries,
    notifications,
    statuses,
  };
}

function createUiSink(harness: FakePi): GateUi {
  return {
    notify: (message, type) => {
      harness.notifications.push({ message, type });
    },
    select: async () => undefined,
    confirm: async () => true,
    editor: async () => undefined,
    setStatus: (_key, value) => {
      harness.statuses.push(value ?? "<cleared>");
    },
  };
}

function createContext(harness: FakePi, cwd: string) {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    ui: createUiSink(harness),
    isProjectTrusted: () => true,
  };
}

async function setup() {
  const dir = await tempDir();
  const cwd = join(dir, "project");
  const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });
  const harness = createFakePi();
  // An explicit empty environment keeps the engine choice deterministic: without
  // a key the gate runs the ask-only engine.
  register(harness.api, { store, now: () => 1, env: {} });
  return { cwd, store, harness };
}

describe("registration", () => {
  it("registers the startup flag, the command, and the tool_call handler", async () => {
    const { harness } = await setup();
    assert.equal(harness.flags.get(AUTO_MODE_FLAG), false);
    assert.ok(harness.commands.has(AUTO_MODE_COMMAND));
    assert.equal(harness.handlers.get("tool_call")?.length, 1);
    assert.equal(harness.handlers.get("session_start")?.length, 1);
  });

  it("loads settings on session start and shows the footer status", async () => {
    const { cwd, harness } = await setup();
    await harness.handlers.get("session_start")?.[0]?.({}, createContext(harness, cwd));
    assert.equal(harness.statuses.at(-1), "🛡 jev ask-only (global)");
  });
});

describe("tool_call wiring", () => {
  it("blocks a hard-deny command through the registered handler", async () => {
    const { cwd, harness } = await setup();
    const handler = harness.handlers.get("tool_call")?.[0];
    assert.ok(handler);

    const result = (await handler({ toolName: "bash", input: { command: "rm -rf /" } }, createContext(harness, cwd))) as
      | { block?: boolean; reason?: string }
      | undefined;

    assert.equal(result?.block, true);
    const record = harness.entries.find((entry) => entry.customType === DECISION_ENTRY_TYPE);
    assert.equal((record?.data as { source?: string }).source, "hard-deny");
  });

  it("lets a safe command through without a record", async () => {
    const { cwd, harness } = await setup();
    const handler = harness.handlers.get("tool_call")?.[0];
    assert.ok(handler);

    const result = await handler({ toolName: "bash", input: { command: "git status" } }, createContext(harness, cwd));
    assert.equal(result, undefined);
    assert.deepEqual(harness.entries, []);
  });
});

describe("command wiring", () => {
  it("persists an explicit disable to the global settings file and reflects it in the footer", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await harness.handlers.get("session_start")?.[0]?.({}, createContext(harness, cwd));
    await command.handler("off", createContext(harness, cwd));

    assert.equal(harness.statuses.at(-1), "🛡 jev off");
    const saved = await store.loadSettings(cwd, true);
    assert.equal(saved.settings.enabled, false);
    assert.match(harness.notifications.at(-1)?.message ?? "", /disabled/);
  });

  it("reports the active settings and the semantic layer state", async () => {
    const { cwd, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await command.handler("status", createContext(harness, cwd));
    const message = harness.notifications.at(-1)?.message ?? "";
    assert.match(message, /ask-only/);
    assert.match(message, /semantic layer: unavailable \(TYPESAFE_API_KEY is not set\)/);
    assert.match(message, new RegExp(`max state characters: ${DEFAULT_SETTINGS.maxStateCharacters}`));
  });

  it("persists a threshold override and shows the tuning table", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await harness.handlers.get("session_start")?.[0]?.({}, createContext(harness, cwd));
    await command.handler("threshold intent_coverage 0.6", createContext(harness, cwd));

    const saved = await store.loadSettings(cwd, true);
    assert.equal(saved.settings.thresholds.intent_coverage, 0.6);

    const message = harness.notifications.at(-1)?.message ?? "";
    assert.match(message, /requires p >= 0\.60/);
    assert.match(message, /intent_coverage\s+required\s+hazard\s+0\.60 override/);
  });

  it("lists the thresholds without changing them", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await command.handler("threshold", createContext(harness, cwd));
    assert.match(harness.notifications.at(-1)?.message ?? "", /no_secret_egress/);
    assert.deepEqual((await store.loadSettings(cwd, true)).settings.thresholds, {});
  });

  it("refuses an out-of-range value and an unknown rule", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await command.handler("threshold intent_coverage 0.4", createContext(harness, cwd));
    assert.match(harness.notifications.at(-1)?.message ?? "", /greater than 0\.5/);
    assert.equal(harness.notifications.at(-1)?.type, "error");

    await command.handler("threshold nope 0.9", createContext(harness, cwd));
    assert.match(harness.notifications.at(-1)?.message ?? "", /Unknown rule/);

    assert.deepEqual((await store.loadSettings(cwd, true)).settings.thresholds, {});
  });

  it("resets one override and all overrides", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await command.handler("threshold intent_coverage 0.6", createContext(harness, cwd));
    await command.handler("threshold local_scope 0.95", createContext(harness, cwd));
    await command.handler("threshold reset intent_coverage", createContext(harness, cwd));
    assert.deepEqual((await store.loadSettings(cwd, true)).settings.thresholds, { local_scope: 0.95 });

    await command.handler("threshold reset", createContext(harness, cwd));
    assert.deepEqual((await store.loadSettings(cwd, true)).settings.thresholds, {});
  });
});
