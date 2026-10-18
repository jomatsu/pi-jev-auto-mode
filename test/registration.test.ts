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
  /** What the next `ctx.ui.input` returns. */
  enteredKey: string | undefined;
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
    enteredKey: undefined,
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
    input: async () => harness.enteredKey,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function setup(options: { fetch?: (input: string, init?: RequestInit) => Promise<Response>; env?: NodeJS.ProcessEnv } = {}) {
  const dir = await tempDir();
  const cwd = join(dir, "project");
  const store = new JevAutoModeStore({ agentDir: join(dir, "agent"), configDirName: ".pi" });
  const harness = createFakePi();
  // An explicit empty environment keeps the engine choice deterministic: without
  // a key the gate runs the ask-only engine. Any unexpected HTTP call is loud.
  register(harness.api, {
    store,
    now: () => 1,
    env: options.env ?? {},
    fetch:
      options.fetch ??
      (async () => {
        throw new Error("unexpected fetch");
      }),
  });
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
    assert.equal(harness.statuses.at(-1), "🛡 jev no key (global)");
  });

  it("reports the active provider without exposing its key", async () => {
    const { cwd, harness } = await setup({ env: { JEV_AUTO_MODE_PROVIDER: "perplexity", PERPLEXITY_API_KEY: "private-test-key" } });
    const ctx = createContext(harness, cwd);
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);
    await harness.commands.get(AUTO_MODE_COMMAND)?.handler("status", ctx);
    assert.equal(harness.statuses.at(-1), "🛡 perplexity (global)");
    const message = harness.notifications.at(-1)?.message ?? "";
    assert.match(message, /provider: perplexity/);
    assert.match(message, /pplx-decider-v1-27b/);
    assert.match(message, /PERPLEXITY_API_KEY/);
    assert.doesNotMatch(message, /private-test-key/);
  });

  it("reports OpenAI Decisions in the footer and status without its key", async () => {
    const { cwd, harness } = await setup({ env: { JEV_AUTO_MODE_PROVIDER: "openai", OPENAI_API_KEY: "private-test-key" } });
    const ctx = createContext(harness, cwd);
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);
    assert.equal(harness.statuses.at(-1), "🛡 openai (global)");
    await harness.commands.get(AUTO_MODE_COMMAND)?.handler("status", ctx);
    const message = harness.notifications.at(-1)?.message ?? "";
    assert.match(message, /semantic layer: gpt-6-luna \(OPENAI_API_KEY\)/);
    assert.doesNotMatch(message, /private-test-key/);
  });

  it("reports OpenAI as unavailable without OPENAI_API_KEY", async () => {
    const { cwd, harness } = await setup({ env: { JEV_AUTO_MODE_PROVIDER: "openai", TYPESAFE_API_KEY: "no-fallback" } });
    const ctx = createContext(harness, cwd);
    await harness.handlers.get("session_start")?.[0]?.({}, ctx);
    assert.match(harness.notifications.at(-1)?.message ?? "", /OPENAI_API_KEY/);
    assert.equal(harness.statuses.at(-1), "🛡 openai unavailable (global)");
  });

  it("keeps login/logout from changing a TypeSafe key while another provider is selected", async () => {
    let calls = 0;
    const { cwd, store, harness } = await setup({ env: { JEV_AUTO_MODE_PROVIDER: "strands" }, fetch: async () => {
      calls++;
      return jsonResponse({ models: [{ name: "jev-latest" }] });
    } });
    await store.writeStoredApiKey("stored-typesafe-test-key");
    harness.enteredKey = "replacement-test-key";
    for (const action of ["login", "logout"]) {
      await harness.commands.get(AUTO_MODE_COMMAND)?.handler(action, createContext(harness, cwd));
      assert.match(harness.notifications.at(-1)?.message ?? "", /TypeSafe key only/);
      assert.equal(await store.readStoredApiKey(), "stored-typesafe-test-key");
    }
    assert.equal(calls, 0);
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
    assert.match(message, /no key/);
    assert.match(message, /semantic layer: unavailable \(no TypeSafe API key is available \(run \/jev-auto-mode login/);
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
    assert.match(message, /intent_coverage\s+hazard\s+hazard\s+0\.60 override/);
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

  it("stores a verified API key, switches the engine, and removes it on logout", async () => {
    // The SDK validates the shape: an authenticated models response is { models: [...] }.
    const { cwd, store, harness } = await setup({
      fetch: async () => jsonResponse({ models: [{ name: "jev-latest" }] }),
    });
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await harness.handlers.get("session_start")?.[0]?.({}, createContext(harness, cwd));
    assert.equal(harness.statuses.at(-1), "🛡 jev no key (global)");

    harness.enteredKey = "apikey_verified";
    await command.handler("login", createContext(harness, cwd));
    assert.equal(await store.readStoredApiKey(), "apikey_verified");
    assert.equal(harness.statuses.at(-1), "🛡 jev (global)", "the engine is rebuilt without a reload");
    assert.match(harness.notifications.at(-1)?.message ?? "", /verified and stored/);

    await command.handler("logout", createContext(harness, cwd));
    assert.equal(await store.readStoredApiKey(), undefined);
    assert.equal(harness.statuses.at(-1), "🛡 jev no key (global)");
  });

  describe("model command", () => {
    const models = {
      models: [
        { name: "jev-latest", description: "Newest release", release_date: "2026-10-01" },
        { name: "jev-1.12.0", description: "", release_date: "2026-08-01" },
        { name: "jev-1.13.0", description: "Current", release_date: "2026-10-01" },
      ],
    };

    async function modelSetup(env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "apikey_env" }, fetch?: () => Promise<Response>) {
      const requests: string[] = [];
      const context = await setup({
        env,
        fetch: fetch ?? (async (url) => { requests.push(String(url)); return jsonResponse(models); }),
      });
      const command = context.harness.commands.get(AUTO_MODE_COMMAND);
      assert.ok(command);
      const ctx = createContext(context.harness, context.cwd);
      await context.harness.handlers.get("session_start")?.[0]?.({}, ctx);
      return { ...context, command, ctx, requests };
    }

    it("defaults to jev-latest and lists the releases available to the key", async () => {
      const { command, ctx, harness, store, cwd, requests } = await modelSetup();
      assert.equal((await store.loadSettings(cwd, true)).settings.jevModel, undefined);
      await command.handler("model", ctx);
      const message = harness.notifications.at(-1)?.message ?? "";
      assert.match(message, /jev model: jev-latest \(default\)/);
      assert.match(message, /jev-1\.13\.0/);
      assert.ok(message.indexOf("jev-1.13.0") < message.indexOf("jev-1.12.0"), "newest release first");
      assert.ok(requests.every((url) => url.endsWith("/v1/models")));
    });

    it("pins a listed release, uses it for judgments, and returns to latest", async () => {
      const { command, ctx, harness, store, cwd } = await modelSetup();
      await command.handler("model jev-1.12.0", ctx);
      assert.equal((await store.loadSettings(cwd, true)).settings.jevModel, "jev-1.12.0");
      assert.match(harness.notifications.at(-1)?.message ?? "", /pinned to jev-1\.12\.0/);
      await command.handler("status", ctx);
      assert.match(harness.notifications.at(-1)?.message ?? "", /semantic layer: jev-1\.12\.0 \[model: jevModel setting\]/);

      await command.handler("model latest", ctx);
      assert.equal((await store.loadSettings(cwd, true)).settings.jevModel, undefined);
      await command.handler("status", ctx);
      assert.match(harness.notifications.at(-1)?.message ?? "", /semantic layer: jev-latest \[model: default\]/);
    });

    it("refuses an unlisted, malformed, or unverifiable release and saves nothing", async () => {
      const { command, ctx, harness, store, cwd } = await modelSetup();
      for (const [argument, pattern] of [["jev-9.9.9", /not available to this key/], ["jev latest", /Not a model name/]] as const) {
        await command.handler(`model ${argument}`, ctx);
        assert.equal(harness.notifications.at(-1)?.type, "error");
        assert.match(harness.notifications.at(-1)?.message ?? "", pattern);
      }
      assert.equal((await store.loadSettings(cwd, true)).settings.jevModel, undefined);

      const offline = await modelSetup(undefined, async () => { throw new TypeError("offline"); });
      await offline.command.handler("model jev-1.12.0", offline.ctx);
      assert.match(offline.harness.notifications.at(-1)?.message ?? "", /unreachable.*nothing was saved/);
      assert.equal((await offline.store.loadSettings(offline.cwd, true)).settings.jevModel, undefined);

      const noKey = await modelSetup({});
      await noKey.command.handler("model jev-1.12.0", noKey.ctx);
      assert.match(noKey.harness.notifications.at(-1)?.message ?? "", /Log in first/);
    });

    it("says an environment override wins and leaves other providers alone", async () => {
      const pinnedByEnv = await modelSetup({ TYPESAFE_API_KEY: "apikey_env", TYPESAFE_DEFAULT_MODEL: "jev-1.13.0" });
      await pinnedByEnv.command.handler("model jev-1.12.0", pinnedByEnv.ctx);
      assert.match(pinnedByEnv.harness.notifications.at(-1)?.message ?? "", /TYPESAFE_DEFAULT_MODEL is set and takes precedence/);

      const openai = await modelSetup({ JEV_AUTO_MODE_PROVIDER: "openai", OPENAI_API_KEY: "k" }, async () => { throw new Error("must not fetch"); });
      await openai.command.handler("model jev-1.12.0", openai.ctx);
      assert.match(openai.harness.notifications.at(-1)?.message ?? "", /applies to TypeSafe \(Jev\) only/);
      assert.equal((await openai.store.loadSettings(openai.cwd, true)).settings.jevModel, undefined);
    });
  });

  it("refuses a key the API rejects and stores nothing", async () => {
    const { cwd, store, harness } = await setup({ fetch: async () => jsonResponse({ error: "nope" }, 401) });
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    harness.enteredKey = "apikey_wrong";
    await command.handler("login", createContext(harness, cwd));

    assert.equal(await store.readStoredApiKey(), undefined);
    assert.equal(harness.notifications.at(-1)?.type, "error");
    assert.match(harness.notifications.at(-1)?.message ?? "", /rejected that key/);
  });

  it("stores nothing when the key cannot be verified", async () => {
    const { cwd, store, harness } = await setup({ fetch: async () => { throw new TypeError("offline"); } });
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    harness.enteredKey = "apikey_unverified";
    await command.handler("login", createContext(harness, cwd));

    assert.equal(await store.readStoredApiKey(), undefined);
    assert.match(harness.notifications.at(-1)?.message ?? "", /Could not reach the TypeSafe API/);
  });

  it("does nothing when the login prompt is dismissed", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    harness.enteredKey = undefined;
    await command.handler("login", createContext(harness, cwd));

    assert.equal(await store.readStoredApiKey(), undefined);
    assert.match(harness.notifications.at(-1)?.message ?? "", /cancelled/);
  });

  it("reports when there is no stored key to remove", async () => {
    const { cwd, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await command.handler("logout", createContext(harness, cwd));
    assert.match(harness.notifications.at(-1)?.message ?? "", /No stored API key/);
  });

  it("switches how the uncertain band resolves, and persists it", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await command.handler("uncertain", createContext(harness, cwd));
    assert.match(harness.notifications.at(-1)?.message ?? "", /uncertain: allow/);

    await command.handler("uncertain deny", createContext(harness, cwd));
    assert.equal((await store.loadSettings(cwd, true)).settings.uncertain, "deny");

    await command.handler("uncertain maybe", createContext(harness, cwd));
    assert.equal(harness.notifications.at(-1)?.type, "error");
    assert.equal((await store.loadSettings(cwd, true)).settings.uncertain, "deny");
  });

  it("switches how decision records are drawn, and persists it", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await command.handler("display", createContext(harness, cwd));
    assert.match(harness.notifications.at(-1)?.message ?? "", /display: compact/);

    await command.handler("display full", createContext(harness, cwd));
    assert.equal((await store.loadSettings(cwd, true)).settings.display, "full");

    await command.handler("display tiny", createContext(harness, cwd));
    assert.equal(harness.notifications.at(-1)?.type, "error");
    assert.equal((await store.loadSettings(cwd, true)).settings.display, "full");
  });

  it("switches the gate scope, and persists it", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    await command.handler("scope", createContext(harness, cwd));
    assert.match(harness.notifications.at(-1)?.message ?? "", /gate scope: all/);

    await command.handler("scope matched", createContext(harness, cwd));
    assert.equal((await store.loadSettings(cwd, true)).settings.gateScope, "matched");

    await command.handler("scope sometimes", createContext(harness, cwd));
    assert.equal(harness.notifications.at(-1)?.type, "error");
    assert.equal((await store.loadSettings(cwd, true)).settings.gateScope, "matched");
  });

  it("tunes a threshold through the picker", async () => {
    const { cwd, store, harness } = await setup();
    const command = harness.commands.get(AUTO_MODE_COMMAND);
    assert.ok(command);

    const ctx = createContext(harness, cwd);
    // The picker is select -> input, so it needs a UI that answers both.
    ctx.ui.select = async () => "intent_coverage  (t=0.8)";
    ctx.ui.input = async () => "0.95";

    await command.handler("threshold edit", ctx);
    assert.equal((await store.loadSettings(cwd, true)).settings.thresholds.intent_coverage, 0.95);
    assert.match(harness.notifications.at(-1)?.message ?? "", /requires p >= 0.95/);
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
