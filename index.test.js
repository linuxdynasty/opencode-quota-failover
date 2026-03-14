import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import quotaFailoverPlugin, { isUsageLimitError, isDefinitiveQuotaError, isAmbiguousRateLimitSignal, failoverEventLog } from "./index.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_SETTINGS_DIR = mkdtempSync(join(tmpdir(), "opencode-quota-failover-tests-"));
const TEST_SETTINGS_PATH = join(TEST_SETTINGS_DIR, "settings.json");

function writeDefaultTestSettings() {
  writeFileSync(
    TEST_SETTINGS_PATH,
    JSON.stringify(
      {
        providerChain: ["amazon-bedrock", "openai"],
        modelByProviderAndTier: {
          "amazon-bedrock": {
            opus: "us.anthropic.claude-opus-4-6-v1",
            sonnet: "us.anthropic.claude-sonnet-4-6",
            haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0"
          },
          openai: {
            opus: "gpt-5.4",
            sonnet: "gpt-5.3-codex",
            haiku: "gpt-5.2-codex"
          },
          anthropic: {
            opus: "claude-opus-4-6",
            sonnet: "claude-sonnet-4-6",
            haiku: "claude-haiku-4-5"
          }
        },
        debugToasts: true,
        stallWatchdogMs: 45000
      },
      null,
      2
    )
  );
}

beforeEach(() => {
  process.env.OPENCODE_FAILOVER_SETTINGS_PATH = TEST_SETTINGS_PATH;
  writeDefaultTestSettings();
});

afterAll(() => {
  rmSync(TEST_SETTINGS_DIR, { recursive: true, force: true });
});

function createContext(messagesBySession) {
  const promptCalls = [];
  const toastCalls = [];
  const abortCalls = [];

  const ctx = {
    directory: process.cwd(),
    client: {
      session: {
        messages: async ({ path }) => ({
          data: messagesBySession[path.id] ?? []
        }),
        prompt: async (request) => {
          promptCalls.push(request);
          return { data: {} };
        },
        abort: async (request) => {
          abortCalls.push(request);
          return { data: true };
        }
      },
      tui: {
        showToast: async (request) => {
          toastCalls.push(request);
          return { data: true };
        }
      }
    }
  };

  return { ctx, promptCalls, toastCalls, abortCalls };
}

function makeUserMessage(
  sessionID,
  {
    id = "u1",
    agent = "general",
    providerID = "openai",
    modelID = "gpt-5.3-codex",
    text = "retry this request"
  } = {}
) {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      agent,
      model: { providerID, modelID },
      system: "system prompt",
      tools: { bash: true }
    },
    parts: [{ type: "text", text }]
  };
}

function makeAssistantErrorMessage(sessionID, providerID, modelID, errorMessage, statusCode = 429, id = "a1") {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      providerID,
      modelID,
      error: {
        name: "APIError",
        data: {
          message: errorMessage,
          statusCode,
          isRetryable: false
        }
      }
    },
    parts: []
  };
}

function tierFromModelID(modelID) {
  const id = (modelID ?? "").toLowerCase();
  if (id.includes("opus") || id.includes("gpt-5.3") || id.includes("gpt-5.2")) {
    return "opus";
  }
  if (id.includes("sonnet") || id.includes("gpt-5.1")) {
    return "sonnet";
  }
  if (id.includes("haiku") || id.includes("mini")) {
    return "haiku";
  }
  return null;
}

function expectedBedrockModelForTier(tier) {
  if (tier === "sonnet") return "us.anthropic.claude-sonnet-4-6";
  if (tier === "haiku") return "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  return "us.anthropic.claude-opus-4-6-v1";
}

function makeToolContext(sessionID = "tool-session") {
  return {
    sessionID,
    messageID: `m-${sessionID}`,
    agent: "test-agent",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  };
}

async function withFakeTimers(run) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];

  globalThis.setTimeout = (fn, ms) => {
    const handle = {
      fn,
      ms,
      cleared: false
    };
    timers.push(handle);
    return handle;
  };

  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === "object") {
      handle.cleared = true;
    }
  };

  try {
    await run(timers);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

async function withTempSettings(run) {
  const previous = process.env.OPENCODE_FAILOVER_SETTINGS_PATH;
  const dir = mkdtempSync(join(tmpdir(), "opencode-quota-failover-"));
  const settingsPath = join(dir, "settings.json");
  process.env.OPENCODE_FAILOVER_SETTINGS_PATH = settingsPath;
  try {
    await run(settingsPath);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCODE_FAILOVER_SETTINGS_PATH;
    } else {
      process.env.OPENCODE_FAILOVER_SETTINGS_PATH = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("opencode-quota-failover", () => {
  test("shows a visible failover info toast on first message per session", async () => {
    const { ctx, toastCalls } = createContext({});
    const hooks = await quotaFailoverPlugin(ctx);

    const chatInput = {
      sessionID: "toast-1",
      agent: "sisyphus",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6"
      }
    };

    await hooks["chat.message"](chatInput, {
      message: {},
      parts: []
    });
    await hooks["chat.message"](chatInput, {
      message: {},
      parts: []
    });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].body.title).toBe("Failover Active");
    expect(toastCalls[0].body.message).toContain("Current model: anthropic/claude-sonnet-4-6");
    expect(toastCalls[0].body.message).toContain("1) amazon-bedrock/us.anthropic.claude-sonnet-4-6");
    expect(toastCalls[0].body.message).toContain("2) openai/gpt-5.3-codex");
  });

  test("system prompt shows current model, fallback models, and timing policy", async () => {
    const { ctx } = createContext({});
    const hooks = await quotaFailoverPlugin(ctx);
    const output = { system: [] };

    await hooks["experimental.chat.system.transform"](
      {
        sessionID: "sys-1",
        model: {
          providerID: "anthropic",
          id: "claude-sonnet-4-6"
        }
      },
      output
    );

    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain("[opencode-quota-failover]");
    expect(output.system[0]).toContain("Current model: anthropic/claude-sonnet-4-6");
    expect(output.system[0]).toContain("1) amazon-bedrock/us.anthropic.claude-sonnet-4-6");
    expect(output.system[0]).toContain("2) openai/gpt-5.3-codex");
    expect(output.system[0]).toContain("Takeover timing:");
  });

  test("retries on Bedrock Opus 4.6 when OpenAI usage limit error is detected", async () => {
    const sessionID = "s1";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, { id: "u1", agent: "gsd-executor" }),
        makeAssistantErrorMessage(
          sessionID,
          "openai",
          "gpt-5.3-codex",
          "You exceeded your current quota, please check your plan and billing details."
        )
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: messagesBySession[sessionID][1].info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-sonnet-4-6"
    });
    expect(promptCalls[0].body.agent).toBe("gsd-executor");
    expect(promptCalls[0].body.parts[0]).toMatchObject({ type: "text", text: "retry this request" });
  });

  test("treats account-level rate limit with long retry window as failover signal", async () => {
    const sessionID = "s-rate-retry-window";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-rate-retry-window",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "This request would exceed your account's rate limit. Please try again later. [retrying in 1h 39m]",
          429
        )
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: messagesBySession[sessionID][1].info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-opus-4-6-v1"
    });
    expect(promptCalls[0].body.agent).toBe("sisyphus");
  });

  test("shows dashboard-style failover toast with from/to model details", async () => {
    const sessionID = "s-rich-toast";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-rich-toast",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "insufficient_quota"
        )
      ]
    };
    const { ctx, toastCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.tool.failover_set_debug.execute(
      { enabled: false },
      makeToolContext(sessionID)
    );

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: messagesBySession[sessionID][1].info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    const failoverToast = toastCalls.find((call) => call?.body?.title === "Model Failover");
    expect(failoverToast).toBeDefined();
    expect(failoverToast.body.message).toContain("Failover Active");
    expect(failoverToast.body.message).toContain("From: anthropic/claude-opus-4-6");
    expect(failoverToast.body.message).toContain("To:   amazon-bedrock/us.anthropic.claude-opus-4-6-v1");
    expect(failoverToast.body.message).toContain("Trigger:");
    expect(failoverToast.body.message).toContain("Chain:");

    await hooks.tool.failover_set_debug.execute(
      { enabled: true },
      makeToolContext(sessionID)
    );
  });

  test("maps Anthropic Sonnet to Bedrock Sonnet and preserves agent", async () => {
    const sessionID = "s-sonnet";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-sonnet",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-sonnet-4-6",
          "insufficient_quota"
        )
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: messagesBySession[sessionID][1].info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-sonnet-4-6"
    });
    expect(promptCalls[0].body.agent).toBe("sisyphus");
  });

  test("ignores context/token limit errors", async () => {
    const sessionID = "s2";
    const assistantInfo = makeAssistantErrorMessage(
      sessionID,
      "anthropic",
      "claude-opus-4-6",
      "prompt is too long: context length exceeded token limit"
    ).info;

    const { ctx, promptCalls } = createContext({
      [sessionID]: [makeUserMessage(sessionID, { id: "u2" })]
    });
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: assistantInfo }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    expect(promptCalls).toHaveLength(0);
  });

  test("moves from Bedrock Sonnet to OpenAI Sonnet-equivalent when Bedrock also fails", async () => {
    const sessionID = "s3";
    const user = makeUserMessage(sessionID, {
      id: "u3",
      agent: "gsd-verifier",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6"
    });
    const messagesBySession = {
      [sessionID]: [user]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantErrorMessage(
            sessionID,
            "anthropic",
            "claude-sonnet-4-6",
            "insufficient_quota"
          ).info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantErrorMessage(
            sessionID,
            "amazon-bedrock",
            "us.anthropic.claude-sonnet-4-6",
            "usage limit reached"
          ).info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-sonnet-4-6"
    });
    expect(promptCalls[1].body.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex"
    });
    expect(promptCalls[1].body.agent).toBe("gsd-verifier");
  });

  test("forces immediate failover when session enters retry status due to quota/rate limit", async () => {
    const sessionID = "s-retry-status";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-retry-status",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "This request would exceed your account's rate limit. Please try again later."
        )
      ]
    };
    const { ctx, promptCalls, abortCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 2,
            message: "This request would exceed your account's rate limit. Please try again later. [retrying in 1h 39m]",
            next: Date.now() + 10_000
          }
        }
      }
    });

    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].path.id).toBe(sessionID);
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.agent).toBe("sisyphus");
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-opus-4-6-v1"
    });
  });

  test("stall watchdog does NOT arm by default after failover dispatch", async () => {
    await withFakeTimers(async (timers) => {
      const sessionID = "s-watchdog-default-off";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-watchdog-default-off",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(
            sessionID,
            "anthropic",
            "claude-opus-4-6",
            "insufficient_quota"
          )
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID }
        }
      });

      expect(promptCalls).toHaveLength(1);
      // With stallWatchdogEnabled: false (default), NO timer should be set
      expect(timers).toHaveLength(0);
    });
  });

  test("stall watchdog arms when stallWatchdogEnabled is true in settings", async () => {
    await withFakeTimers(async (timers) => {
      const sessionID = "s-watchdog-explicit-on";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-watchdog-explicit-on",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(
            sessionID,
            "anthropic",
            "claude-opus-4-6",
            "insufficient_quota"
          )
        ]
      };
      const settingsWithWatchdog = JSON.parse(readFileSync(process.env.OPENCODE_FAILOVER_SETTINGS_PATH, "utf8"));
      settingsWithWatchdog.stallWatchdogEnabled = true;
      writeFileSync(
        process.env.OPENCODE_FAILOVER_SETTINGS_PATH,
        JSON.stringify(settingsWithWatchdog, null, 2)
      );

      const { ctx, promptCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID }
        }
      });

      expect(promptCalls).toHaveLength(1);
      // With stallWatchdogEnabled: true, ONE timer should be set
      expect(timers).toHaveLength(1);
      expect(timers[0].ms).toBe(45000);
    });
  });

  test("watchdog auto-fails over again when first fallback has no output", async () => {
    await withFakeTimers(async (timers) => {
      // Enable watchdog for this test
      const currentSettings = JSON.parse(readFileSync(process.env.OPENCODE_FAILOVER_SETTINGS_PATH, "utf8"));
      currentSettings.stallWatchdogEnabled = true;
      writeFileSync(process.env.OPENCODE_FAILOVER_SETTINGS_PATH, JSON.stringify(currentSettings, null, 2));

      const sessionID = "s-stall-watchdog";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-stall-watchdog",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(
            sessionID,
            "anthropic",
            "claude-opus-4-6",
            "insufficient_quota"
          )
        ]
      };
      const { ctx, promptCalls, abortCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: messagesBySession[sessionID][1].info
          }
        }
      });
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID }
        }
      });

      expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-opus-4-6-v1"
    });
      expect(timers).toHaveLength(1);
      expect(timers[0].ms).toBe(45000);

      await timers[0].fn();

      expect(abortCalls).toHaveLength(1);
      expect(abortCalls[0].path.id).toBe(sessionID);
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1].body.model).toEqual({
        providerID: "openai",
        modelID: "gpt-5.4"
      });
    });
  });

  test("watchdog disarms after first output delta and does not force extra failover", async () => {
    await withFakeTimers(async (timers) => {
      // Enable watchdog for this test
      const currentSettings = JSON.parse(readFileSync(process.env.OPENCODE_FAILOVER_SETTINGS_PATH, "utf8"));
      currentSettings.stallWatchdogEnabled = true;
      writeFileSync(process.env.OPENCODE_FAILOVER_SETTINGS_PATH, JSON.stringify(currentSettings, null, 2));

      const sessionID = "s-stall-watchdog-delta";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-stall-watchdog-delta",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(
            sessionID,
            "anthropic",
            "claude-opus-4-6",
            "insufficient_quota"
          )
        ]
      };
      const { ctx, promptCalls, abortCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: messagesBySession[sessionID][1].info
          }
        }
      });
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID }
        }
      });

      expect(promptCalls).toHaveLength(1);
      expect(timers).toHaveLength(1);

      await hooks.event({
        event: {
          type: "message.part.delta",
          properties: {
            sessionID
          }
        }
      });

      expect(timers[0].cleared).toBe(true);
      await timers[0].fn();
      expect(abortCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
    });
  });

  test("global cooldown suppresses second session failover within 60s", async () => {
    const sessionID1 = "s-cooldown-1";
    const sessionID2 = "s-cooldown-2";
    const messagesBySession = {
      [sessionID1]: [
        makeUserMessage(sessionID1, {
          id: "u-cooldown-1",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(sessionID1, "anthropic", "claude-opus-4-6", "insufficient_quota")
      ],
      [sessionID2]: [
        makeUserMessage(sessionID2, {
          id: "u-cooldown-2",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(sessionID2, "anthropic", "claude-opus-4-6", "insufficient_quota")
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    // Session 1 triggers failover - should succeed
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: messagesBySession[sessionID1][1].info }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sessionID1 } }
    });

    // Session 2 triggers failover immediately after - should be suppressed by cooldown
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: messagesBySession[sessionID2][1].info }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sessionID2 } }
    });

    // Only session 1 should have dispatched failover
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].path.id).toBe(sessionID1);
  });

  test("global cooldown allows failover after cooldown window expires", async () => {
    const sessionID1 = "s-cooldown-expired-1";
    const sessionID2 = "s-cooldown-expired-2";
    const messagesBySession = {
      [sessionID1]: [
        makeUserMessage(sessionID1, {
          id: "u-expired-1",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(sessionID1, "anthropic", "claude-opus-4-6", "insufficient_quota")
      ],
      [sessionID2]: [
        makeUserMessage(sessionID2, {
          id: "u-expired-2",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(sessionID2, "anthropic", "claude-opus-4-6", "insufficient_quota")
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);

    // Set cooldown to 0 to simulate expired cooldown for this test
    const currentSettings = JSON.parse(readFileSync(process.env.OPENCODE_FAILOVER_SETTINGS_PATH, "utf8"));
    currentSettings.globalCooldownMs = 0;
    writeFileSync(process.env.OPENCODE_FAILOVER_SETTINGS_PATH, JSON.stringify(currentSettings, null, 2));

    const hooks = await quotaFailoverPlugin(ctx);

    // Session 1 triggers failover
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: messagesBySession[sessionID1][1].info }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sessionID1 } }
    });

    // Session 2 triggers failover with cooldown=0 (expired/disabled) - should succeed
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: messagesBySession[sessionID2][1].info }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: sessionID2 } }
    });

    // BOTH sessions should have dispatched failover
    expect(promptCalls).toHaveLength(2);
  });

  test("failover_now tool bypasses global cooldown", async () => {
    const sessionID = "s-cooldown-manual";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-cooldown-manual",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
          text: "continue work"
        }),
        makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    // Trigger auto failover on the session first (sets global cooldown)
    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: messagesBySession[sessionID][1].info }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID } }
    });

    expect(promptCalls).toHaveLength(1); // auto failover dispatched

    // Manual failover_now should still work despite cooldown being active
    const result = await hooks.tool.failover_now.execute({}, makeToolContext(sessionID));
    expect(result).toContain("Failover-now dispatched.");
    expect(promptCalls).toHaveLength(2); // manual failover also dispatched
  });

  test("retry handler does NOT intercept short backoff even with quota message", async () => {
    const sessionID = "s-retry-short-backoff";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-retry-short-backoff",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "This request would exceed your account's rate limit. Please try again later."
        )
      ]
    };
    const { ctx, promptCalls, abortCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    // Short backoff (2 minutes) - should NOT trigger failover even though message is quota-like
    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 1,
            message: "This request would exceed your account's rate limit. Please try again later. [retrying in 2m]",
            next: Date.now() + 120_000
          }
        }
      }
    });

    expect(abortCalls).toHaveLength(0);
    expect(promptCalls).toHaveLength(0);
  });

  test("retry handler intercepts long backoff with confirmed quota message", async () => {
    const sessionID = "s-retry-long-backoff-quota";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-retry-long-quota",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "This request would exceed your account's rate limit. Please try again later."
        )
      ]
    };
    const { ctx, promptCalls, abortCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    // Long backoff (45 minutes) with quota message - SHOULD trigger failover
    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 2,
            message: "This request would exceed your account's rate limit. Please try again later. [retrying in 45m]",
            next: Date.now() + 2_700_000
          }
        }
      }
    });

    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].path.id).toBe(sessionID);
    expect(promptCalls).toHaveLength(1);
  });

  test("retry handler does NOT intercept long backoff with generic rate limit message", async () => {
    const sessionID = "s-retry-long-generic";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-retry-long-generic",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "rate limit exceeded"
        )
      ]
    };
    const { ctx, promptCalls, abortCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    // Long backoff (45 minutes) but generic rate limit - should NOT trigger
    // because isUsageLimitError rejects generic "rate limit exceeded"
    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 2,
            message: "rate limit exceeded [retrying in 45m]",
            next: Date.now() + 2_700_000
          }
        }
      }
    });

    expect(abortCalls).toHaveLength(0);
    expect(promptCalls).toHaveLength(0);
  });

  test("shows failover debug toasts that include trigger path", async () => {
    const sessionID = "s-debug-toast";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-debug-toast",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "This request would exceed your account's rate limit. Please try again later."
        )
      ]
    };
    const { ctx, toastCalls, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 2,
            message: "This request would exceed your account's rate limit. Please try again later. [retrying in 1h 39m]",
            next: Date.now() + 10_000
          }
        }
      }
    });

    expect(promptCalls).toHaveLength(1);

    const debugMessages = toastCalls
      .map((call) => call?.body?.message ?? "")
      .filter((message) => message.includes("Trigger:"));

    expect(debugMessages.some((message) => message.includes("session.status(retry)"))).toBe(true);
    expect(debugMessages.some((message) => message.includes("failover.dispatch"))).toBe(true);
  });

  test("all configured oh-my-opencode agents preserve agent and map to correct Bedrock fallback tier", async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const configPath = resolve(__dirname, "../../oh-my-opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const agents = config.agents ?? {};
    const configuredAgentNames = Object.keys(agents);

    const messagesBySession = {};
    const expectedBySession = new Map();
    let index = 0;

    for (const [agentName, agentConfig] of Object.entries(agents)) {
      const model = agentConfig?.model;
      if (typeof model !== "string" || !model.includes("/")) {
        continue;
      }

      const [providerID, ...modelParts] = model.split("/");
      const modelID = modelParts.join("/");
      if (!providerID || !modelID) {
        continue;
      }

      const tier = tierFromModelID(modelID);
      if (!tier) {
        continue;
      }
      const expectedBedrockModel = expectedBedrockModelForTier(tier);
      const sessionID = `agent-${index++}`;

      messagesBySession[sessionID] = [
        makeUserMessage(sessionID, {
          id: `u-${sessionID}`,
          agent: agentName,
          providerID,
          modelID
        }),
        makeAssistantErrorMessage(
          sessionID,
          providerID,
          modelID,
          "insufficient_quota",
          429,
          `a-${sessionID}`
        )
      ];

      expectedBySession.set(sessionID, {
        agent: agentName,
        modelID: expectedBedrockModel
      });
    }

    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    for (const sessionID of expectedBySession.keys()) {
      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID }
        }
      });
    }

    expect(expectedBySession.size).toBeLessThanOrEqual(configuredAgentNames.length);
    expect(promptCalls.length).toBeGreaterThan(0);
    expect(promptCalls.length).toBeLessThanOrEqual(expectedBySession.size);

    for (const call of promptCalls) {
      const sessionID = call.path.id;
      const expected = expectedBySession.get(sessionID);
      expect(expected).toBeDefined();
      expect(call.body.agent).toBe(expected.agent);
      expect(call.body.model).toEqual({
        providerID: "amazon-bedrock",
        modelID: expected.modelID
      });
    }
  });

  test("system prompt shows last observed failover latency after fallback completes", async () => {
    const sessionID = "sys-latency";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-latency",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "insufficient_quota"
        )
      ]
    };
    const { ctx } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: messagesBySession[sessionID][1].info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"](
      {
        sessionID,
        model: {
          providerID: "anthropic",
          id: "claude-opus-4-6"
        }
      },
      output
    );

    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain("Last observed takeover latency in this session:");
    expect(output.system[0]).toMatch(/\d+ms/);
  });

  test("tool can disable debug trigger toasts while preserving failover behavior", async () => {
    const sessionID = "tool-debug-toggle";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-tool-debug-toggle",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "This request would exceed your account's rate limit. Please try again later."
        )
      ]
    };
    const { ctx, toastCalls, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.tool.failover_set_debug.execute(
      { enabled: false },
      makeToolContext(sessionID)
    );

    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 1,
            message: "This request would exceed your account's rate limit. Please try again later. [retrying in 1h 39m]",
            next: Date.now() + 10_000
          }
        }
      }
    });

    const debugToasts = toastCalls.filter((call) => call?.body?.title === "Failover Debug");
    expect(debugToasts).toHaveLength(0);
    expect(promptCalls).toHaveLength(1);

    await hooks.tool.failover_set_debug.execute(
      { enabled: true },
      makeToolContext(sessionID)
    );
  });

  test("tool can change provider chain to openai-only for automatic failover", async () => {
    const sessionID = "tool-provider-chain";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-tool-provider-chain",
          agent: "gsd-debugger",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-sonnet-4-6",
          "insufficient_quota"
        )
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.tool.failover_set_providers.execute(
      { providers: ["openai"] },
      makeToolContext(sessionID)
    );

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: messagesBySession[sessionID][1].info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex"
    });
    expect(promptCalls[0].body.agent).toBe("gsd-debugger");

    await hooks.tool.failover_set_providers.execute(
      { providers: ["amazon-bedrock", "openai"] },
      makeToolContext(sessionID)
    );
  });

  test("model catalog tool includes Bedrock Kimi as selectable failover model", async () => {
    const { ctx } = createContext({});
    const hooks = await quotaFailoverPlugin(ctx);

    const report = await hooks.tool.failover_list_models.execute({}, makeToolContext("tool-model-catalog"));

    expect(report).toContain("Failover Model Catalog");
    expect(report).toContain("Provider: amazon-bedrock");
    expect(report).toContain("moonshotai.kimi-k2.5");
    expect(report).toContain("moonshot.kimi-k2-thinking");
  });

  test("tool can set Bedrock Sonnet fallback model to Kimi", async () => {
    const sessionID = "tool-set-model-kimi";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-tool-set-model-kimi",
          agent: "gsd-verifier",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-sonnet-4-6",
          "insufficient_quota"
        )
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.tool.failover_set_model.execute(
      {
        provider: "amazon-bedrock",
        modelID: "moonshotai.kimi-k2.5",
        tier: "sonnet"
      },
      makeToolContext(sessionID)
    );

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: messagesBySession[sessionID][1].info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "moonshotai.kimi-k2.5"
    });

    await hooks.tool.failover_set_model.execute(
      {
        provider: "amazon-bedrock",
        modelID: "us.anthropic.claude-sonnet-4-6",
        tier: "sonnet"
      },
      makeToolContext(sessionID)
    );
  });

  test("tool can set Bedrock Sonnet fallback model to Kimi thinking variant", async () => {
    const sessionID = "tool-set-model-kimi-thinking";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-tool-set-model-kimi-thinking",
          agent: "gsd-verifier",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-sonnet-4-6",
          "insufficient_quota"
        )
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.tool.failover_set_model.execute(
      {
        provider: "amazon-bedrock",
        modelID: "moonshot.kimi-k2-thinking",
        tier: "sonnet"
      },
      makeToolContext(sessionID)
    );

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: messagesBySession[sessionID][1].info
        }
      }
    });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID }
      }
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "moonshot.kimi-k2-thinking"
    });

    await hooks.tool.failover_set_model.execute(
      {
        provider: "amazon-bedrock",
        modelID: "us.anthropic.claude-sonnet-4-6",
        tier: "sonnet"
      },
      makeToolContext(sessionID)
    );
  });

  test("setting kimi-k2.5 returns latency warning guidance", async () => {
    const { ctx } = createContext({});
    const hooks = await quotaFailoverPlugin(ctx);

    const result = await hooks.tool.failover_set_model.execute(
      {
        provider: "amazon-bedrock",
        modelID: "moonshotai.kimi-k2.5",
        tier: "sonnet"
      },
      makeToolContext("tool-kimi-latency-warning")
    );

    expect(result).toContain("Warning: moonshotai.kimi-k2.5 can have long first-token latency");
    expect(result).toContain("moonshot.kimi-k2-thinking");

    await hooks.tool.failover_set_model.execute(
      {
        provider: "amazon-bedrock",
        modelID: "us.anthropic.claude-sonnet-4-6",
        tier: "sonnet"
      },
      makeToolContext("tool-kimi-latency-warning")
    );
  });

  test("persisted settings keep selected Kimi thinking model across plugin reload", async () => {
    await withTempSettings(async () => {
      const sessionID = "tool-persist-kimi-thinking";
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.tool.failover_set_model.execute(
        {
          provider: "amazon-bedrock",
          modelID: "moonshot.kimi-k2-thinking",
          tier: "sonnet"
        },
        makeToolContext(sessionID)
      );

      const { ctx: ctxReloaded } = createContext({});
      const hooksReloaded = await quotaFailoverPlugin(ctxReloaded);
      const status = await hooksReloaded.tool.failover_status.execute({}, makeToolContext(sessionID));

      expect(status).toContain("sonnet: amazon-bedrock/moonshot.kimi-k2-thinking -> openai/gpt-5.3-codex");

    });
  });

  test("failover_now tool immediately dispatches to next fallback model", async () => {
    const sessionID = "tool-failover-now";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-tool-failover-now",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
          text: "continue the migration"
        })
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    const result = await hooks.tool.failover_now.execute({}, makeToolContext(sessionID));
    expect(result).toContain("Failover-now dispatched.");

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-opus-4-6-v1"
    });
    expect(promptCalls[0].body.parts[0]).toMatchObject({ type: "text", text: "continue the migration" });
  });

  test("failover_now skips replaying failover command message itself", async () => {
    const sessionID = "tool-failover-now-command-skip";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-real-work",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          text: "fix flaky integration tests"
        }),
        makeUserMessage(sessionID, {
          id: "u-command",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          text: "/failover-now"
        })
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.tool.failover_now.execute({}, makeToolContext(sessionID));

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.parts[0]).toMatchObject({ type: "text", text: "fix flaky integration tests" });
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-sonnet-4-6"
    });
  });

  test("failover_now supports explicit provider/model target", async () => {
    const sessionID = "tool-failover-now-explicit";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-explicit",
          agent: "gsd-verifier",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          text: "resume verification"
        })
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.tool.failover_now.execute(
      {
        provider: "amazon-bedrock",
        modelID: "moonshotai.kimi-k2.5",
        tier: "sonnet"
      },
      makeToolContext(sessionID)
    );

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "moonshotai.kimi-k2.5"
    });
  });

  test("tool rejects unknown model IDs for provider", async () => {
    const { ctx } = createContext({});
    const hooks = await quotaFailoverPlugin(ctx);

    const result = await hooks.tool.failover_set_model.execute(
      {
        provider: "amazon-bedrock",
        modelID: "moonshotai.kimi-k2.6",
        tier: "sonnet"
      },
      makeToolContext("tool-bad-model")
    );

    expect(result).toContain("Unknown model for provider amazon-bedrock");
    expect(result).toContain("moonshotai.kimi-k2.5");
    expect(result).toContain("moonshot.kimi-k2-thinking");
  });

  test("status tool reports context headroom estimate and subscription quota note", async () => {
    const sessionID = "tool-status";
    const assistantInfo = {
      id: "a-tool-status",
      sessionID,
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
      tokens: {
        input: 120000,
        output: 2000,
        reasoning: 5000,
        cache: {
          read: 0,
          write: 0
        }
      }
    };
    const { ctx } = createContext({
      [sessionID]: [makeUserMessage(sessionID, { id: "u-tool-status" })]
    });
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: assistantInfo }
      }
    });

    const report = await hooks.tool.failover_status.execute(
      { sessionID },
      makeToolContext(sessionID)
    );

    expect(report).toContain("Quota Failover Status");
    expect(report).toContain("Context headroom (current):");
    expect(report).toContain("Claude Max and ChatGPT Pro subscription quota/reset windows are not exposed via plugin APIs.");
  });

  describe("isUsageLimitError - strict quota-only detection", () => {
    // POSITIVE: MUST return true (confirmed quota exhaustion)
    test.each([
      ["insufficient_quota"],
      ["You exceeded your current quota, please check your plan and billing details."],
      ["quota exceeded for this billing period"],
      ["billing hard limit reached"],
      ["billing_hard_limit"],
      ["out of credits"],
      ["insufficient credits for this request"],
      ["servicequotaexceeded"],
      ["you have reached your usage limit"],
      ["monthly usage limit exceeded"],
      ["daily usage limit reached"],
      ["your subscription limit has been reached"],
      ["plan limit reached"],
      ["usage limit exceeded for your account"],
    ])("returns true for confirmed quota: %s", (message) => {
      expect(isUsageLimitError({ message })).toBe(true);
    });

    test("returns true for account-level rate limit", () => {
      expect(isUsageLimitError({
        data: { message: "This request would exceed your account's rate limit. Please try again later.", statusCode: 429 }
      })).toBe(true);
    });

    test("returns true for HTTP 402 with billing language", () => {
      expect(isUsageLimitError({
        data: { message: "Payment required: upgrade your billing plan to continue.", statusCode: 402 }
      })).toBe(true);
    });

    test("returns true for very long retry backoff with account quota language", () => {
      expect(isUsageLimitError({
        data: { message: "account rate limit exceeded [retrying in 1h 39m]", statusCode: 429 }
      })).toBe(true);
    });

    // NEGATIVE: MUST return false (transient, NOT quota exhaustion)
    test.each([
      ["rate limit exceeded, retry in 30 seconds"],
      ["too many requests"],
      ["rate limit"],
      ["throttled, please slow down"],
      ["too many requests, retry after 60s"],
      ["server overloaded"],
      ["connection timeout"],
      ["Rate limit reached. Please retry in 1 minute."],
      ["Request throttled. Limit: 100 requests per minute."],
      ["API rate limit exceeded"],
      ["overloaded_error: temporarily unable to process"],
      ["internal server error"],
      ["rate limit exceeded [retrying in 2m 30s]"],
    ])("returns false for transient error: %s", (message) => {
      expect(isUsageLimitError({ message })).toBe(false);
    });

    test("returns false for 429 rate limit with short backoff", () => {
      expect(isUsageLimitError({
        data: { message: "rate limit exceeded, retry in 30 seconds", statusCode: 429 }
      })).toBe(false);
    });

    test("returns false for 429 with 'limit' in message but not quota", () => {
      expect(isUsageLimitError({
        data: { message: "Rate limit reached. Please retry in 1 minute. Limit: 100 RPM", statusCode: 429 }
      })).toBe(false);
    });
  });

  describe("isDefinitiveQuotaError - hard quota only", () => {
    test.each([
      ["insufficient_quota"],
      ["You exceeded your current quota, please check your plan and billing details."],
      ["quota exceeded for this billing period"],
      ["billing hard limit reached"],
      ["out of credits"],
      ["insufficient credits for this request"],
      ["servicequotaexceeded"],
      ["you have reached your usage limit"],
      ["monthly usage limit exceeded"],
      ["daily usage limit reached"],
      ["your subscription limit has been reached"],
      ["plan limit reached"],
      ["usage limit exceeded for your account"],
    ])("returns true for definitive quota: %s", (message) => {
      expect(isDefinitiveQuotaError({ message })).toBe(true);
    });

    test("returns true for HTTP 402 + billing language", () => {
      expect(isDefinitiveQuotaError({
        data: { message: "Payment required: upgrade your billing plan", statusCode: 402 }
      })).toBe(true);
    });

    test("returns true for long backoff + account words in error text", () => {
      expect(isDefinitiveQuotaError({
        message: "This request would exceed your account's rate limit. Please try again later. [retrying in 1h 39m]"
      })).toBe(true);
    });

    test("returns false for 'account rate limit' WITHOUT long backoff in text", () => {
      expect(isDefinitiveQuotaError({
        message: "This request would exceed your account's rate limit. Please try again later."
      })).toBe(false);
    });

    test("returns false for transient rate limit", () => {
      expect(isDefinitiveQuotaError({ message: "rate limit exceeded, retry in 30 seconds" })).toBe(false);
    });

    test("returns false for generic too many requests", () => {
      expect(isDefinitiveQuotaError({ message: "too many requests" })).toBe(false);
    });

    test("returns false for context length errors", () => {
      expect(isDefinitiveQuotaError({ message: "context length exceeded" })).toBe(false);
    });

    test("returns false for server overloaded", () => {
      expect(isDefinitiveQuotaError({ message: "overloaded_error: temporarily unable to process" })).toBe(false);
    });
  });

  describe("isAmbiguousRateLimitSignal - deferred to session.status", () => {
    test("returns true for 'would exceed account rate limit'", () => {
      expect(isAmbiguousRateLimitSignal({
        message: "This request would exceed your account's rate limit. Please try again later."
      })).toBe(true);
    });

    test("returns true for 'accounts rate limit' without apostrophe", () => {
      expect(isAmbiguousRateLimitSignal({
        message: "accounts rate limit exceeded"
      })).toBe(true);
    });

    test("returns false for generic rate limit without account qualifier", () => {
      expect(isAmbiguousRateLimitSignal({ message: "rate limit exceeded" })).toBe(false);
    });

    test("returns false for hard quota patterns", () => {
      expect(isAmbiguousRateLimitSignal({ message: "insufficient_quota" })).toBe(false);
    });

    test("returns false for context length errors", () => {
      expect(isAmbiguousRateLimitSignal({ message: "context length exceeded" })).toBe(false);
    });

    test("returns false for too many requests", () => {
      expect(isAmbiguousRateLimitSignal({ message: "too many requests" })).toBe(false);
    });
  });

  test("message.updated does NOT trigger failover for ambiguous 'account rate limit' without backoff", async () => {
    const sessionID = "s-no-false-positive";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-no-false-positive",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "This request would exceed your account's rate limit. Please try again later.",
          429
        )
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: messagesBySession[sessionID][1].info }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID } }
    });

    expect(promptCalls).toHaveLength(0);
  });

  test("session.error does NOT trigger failover for ambiguous 'account rate limit' without backoff", async () => {
    const sessionID = "s-error-no-false-positive";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-error-no-fp",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "noop", 200)
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID, role: "assistant",
            providerID: "anthropic", modelID: "claude-opus-4-6",
            tokens: { input: 1000, output: 0 }
          }
        }
      }
    });

    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: { message: "This request would exceed your account's rate limit. Please try again later." }
        }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID } }
    });

    expect(promptCalls).toHaveLength(0);
  });

  test("message.updated STILL triggers immediately for definitive quota (insufficient_quota)", async () => {
    const sessionID = "s-definitive-still-works";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-definitive",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: messagesBySession[sessionID][1].info }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID } }
    });

    expect(promptCalls).toHaveLength(1);
  });

  test("message.updated STILL triggers when 'account rate limit' includes long backoff in error text", async () => {
    const sessionID = "s-account-rl-long-backoff-text";
    const messagesBySession = {
      [sessionID]: [
        makeUserMessage(sessionID, {
          id: "u-rl-long-backoff-text",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(
          sessionID,
          "anthropic",
          "claude-opus-4-6",
          "This request would exceed your account's rate limit. Please try again later. [retrying in 1h 39m]",
          429
        )
      ]
    };
    const { ctx, promptCalls } = createContext(messagesBySession);
    const hooks = await quotaFailoverPlugin(ctx);

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: messagesBySession[sessionID][1].info }
      }
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID } }
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].body.model).toEqual({
      providerID: "amazon-bedrock",
      modelID: "us.anthropic.claude-opus-4-6-v1"
    });
  });

  describe("processFailover dispatch failure handling", () => {
    function createContextWithFailingPrompt(messagesBySession, failConfig = {}) {
      const promptCalls = [];
      const toastCalls = [];
      const abortCalls = [];
      let promptCallCount = 0;

      const ctx = {
        directory: process.cwd(),
        client: {
          session: {
            messages: async ({ path }) => ({
              data: messagesBySession[path.id] ?? []
            }),
            prompt: async (request) => {
              promptCallCount++;
              const targetProvider = request.body?.model?.providerID;
              if (failConfig.failProviders?.includes(targetProvider)) {
                throw new Error(failConfig.errorMessage ?? `Provider ${targetProvider} not configured`);
              }
              if (failConfig.failOnCalls?.includes(promptCallCount)) {
                throw new Error(failConfig.errorMessage ?? "dispatch failed");
              }
              promptCalls.push(request);
              return { data: {} };
            },
            abort: async (request) => {
              abortCalls.push(request);
              return { data: true };
            }
          },
          tui: {
            showToast: async (request) => {
              toastCalls.push(request);
              return { data: true };
            }
          }
        }
      };
      return { ctx, promptCalls, toastCalls, abortCalls };
    }

    test("advances to next provider when dispatch fails for first target", async () => {
      const sessionID = "s-dispatch-advance";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-dispatch-advance",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };
      const { ctx, promptCalls, toastCalls } = createContextWithFailingPrompt(messagesBySession, {
        failProviders: ["amazon-bedrock"]
      });
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      expect(promptCalls).toHaveLength(1);
      expect(promptCalls[0].body.model.providerID).toBe("openai");
    });

    test("shows dispatch error toast with actual error message", async () => {
      const sessionID = "s-dispatch-error-toast";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-dispatch-error-toast",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };
      const { ctx, toastCalls } = createContextWithFailingPrompt(messagesBySession, {
        failProviders: ["amazon-bedrock"],
        errorMessage: "401 Unauthorized: invalid API key"
      });
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      const errorToast = toastCalls.find((c) => c?.body?.title === "Failover Dispatch Error");
      expect(errorToast).toBeDefined();
      expect(errorToast.body.message).toContain("401 Unauthorized: invalid API key");
      expect(errorToast.body.variant).toBe("error");
    });

    test("shows exhaustion toast when all fallback providers fail dispatch", async () => {
      const sessionID = "s-dispatch-exhausted";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-dispatch-exhausted",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };
      const { ctx, promptCalls, toastCalls } = createContextWithFailingPrompt(messagesBySession, {
        failProviders: ["amazon-bedrock", "openai"]
      });
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      expect(promptCalls).toHaveLength(0);
      const exhaustionToast = toastCalls.find((c) =>
        c?.body?.title === "Model Failover" && c?.body?.message?.includes("All fallback providers failed")
      );
      expect(exhaustionToast).toBeDefined();
      expect(exhaustionToast.body.variant).toBe("error");
    });

    test("keeps failed target in attemptedSet — does not retry same provider", async () => {
      const sessionID = "s-dispatch-no-retry";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-dispatch-no-retry",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };

      const { ctx, promptCalls } = createContextWithFailingPrompt(messagesBySession, {
        failProviders: ["amazon-bedrock"]
      });
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.tool.failover_set_providers.execute(
        { providers: ["amazon-bedrock", "openai", "anthropic"] },
        makeToolContext(sessionID)
      );

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      expect(promptCalls).toHaveLength(1);
      expect(promptCalls[0].body.model.providerID).toBe("openai");

      await hooks.tool.failover_set_providers.execute(
        { providers: ["amazon-bedrock", "openai"] },
        makeToolContext(sessionID)
      );
    });

    test("runManualFailover returns detailed error when dispatch fails", async () => {
      const sessionID = "s-manual-dispatch-error";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-manual-dispatch-error",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
            text: "continue the task"
          })
        ]
      };
      const { ctx } = createContextWithFailingPrompt(messagesBySession, {
        failProviders: ["amazon-bedrock"],
        errorMessage: "404 Model gpt-5.3-codex not found"
      });
      const hooks = await quotaFailoverPlugin(ctx);

      const result = await hooks.tool.failover_now.execute({}, makeToolContext(sessionID));

      expect(result).toContain("404 Model gpt-5.3-codex not found");
      expect(result).toContain("Check provider auth in OpenCode");
    });

    test("summarizeDispatchError extracts status and message from nested error shapes", async () => {
      const sessionID = "s-error-shape-status";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-error-shape-status",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
            text: "continue"
          })
        ]
      };

      const shapes = [
        { error: { message: "not found", statusCode: 404 }, expectedParts: ["404", "not found"] },
        { error: { message: "err", data: { message: "invalid key", statusCode: 401 } }, expectedParts: ["401", "invalid key"] },
        { error: { message: "raw string error" }, expectedParts: ["raw string error"] },
      ];

      for (const { error, expectedParts } of shapes) {
        let promptCallCount = 0;
        const toastCalls = [];
        const ctx = {
          directory: process.cwd(),
          client: {
            session: {
              messages: async ({ path }) => ({
                data: messagesBySession[path.id] ?? []
              }),
              prompt: async () => {
                promptCallCount++;
                const err = new Error(error.message ?? "fail");
                if (error.statusCode) err.statusCode = error.statusCode;
                if (error.status) err.status = error.status;
                if (error.data) err.data = error.data;
                if (error.code) err.code = error.code;
                throw err;
              },
              abort: async () => ({ data: true })
            },
            tui: {
              showToast: async (request) => {
                toastCalls.push(request);
                return { data: true };
              }
            }
          }
        };
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.tool.failover_now.execute({}, makeToolContext(sessionID));

        const errorToast = toastCalls.find((c) => c?.body?.title === "Failover Dispatch Error");
        if (errorToast) {
          for (const part of expectedParts) {
            expect(errorToast.body.message).toContain(part);
          }
        } else {
          const lastResult = await hooks.tool.failover_now.execute({}, makeToolContext(sessionID));
          for (const part of expectedParts) {
            expect(lastResult).toContain(part);
          }
        }
      }
    });

    test("debug toast includes error details for message.updated quota trigger", async () => {
      const sessionID = "s-debug-toast-error-details";
      const errorObj = {
        name: "APIError",
        message: "insufficient_quota",
        data: {
          message: "quota exceeded",
          statusCode: 429,
          isRetryable: false
        }
      };
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-debug-toast-error-details",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          {
            info: {
              id: "a-debug-toast-error-details",
              sessionID,
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
              error: errorObj
            },
            parts: []
          }
        ]
      };
      const { ctx, toastCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });

      const debugToast = toastCalls.find(
        (c) => c?.body?.title === "Failover Debug" && c?.body?.message?.includes("message.updated")
      );
      expect(debugToast).toBeDefined();
      const msg = debugToast.body.message;
      expect(msg.includes("quota exceeded") || msg.includes("insufficient_quota")).toBe(true);
    });

    test("openai dispatch failure toast includes exact reason and actionable auth hint", async () => {
      const sessionID = "s-openai-auth-hint";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-openai-auth-hint",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };
      const { ctx, toastCalls } = createContextWithFailingPrompt(messagesBySession, {
        failProviders: ["openai"],
        errorMessage: "403 Forbidden: account not authorized for this organization"
      });
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.tool.failover_set_providers.execute(
        { providers: ["openai", "amazon-bedrock"] },
        makeToolContext(sessionID)
      );

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      const errorToast = toastCalls.find((c) => c?.body?.title === "Failover Dispatch Error");
      expect(errorToast).toBeDefined();
      expect(errorToast.body.message).toContain("Reason: 403 Forbidden: account not authorized for this organization");
      expect(errorToast.body.message).toContain("Category: auth_config");
      expect(errorToast.body.message).toContain("ChatGPT account login is not OpenAI API auth here");

      await hooks.tool.failover_set_providers.execute(
        { providers: ["amazon-bedrock", "openai"] },
        makeToolContext(sessionID)
      );
    });
  });

  describe("failover event logging", () => {
    test("logs TRIGGER event with timestamp and reason when quota error detected", async () => {
      const sessionID = "s-log-trigger";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-log-trigger",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };
      const { ctx } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });

      const triggerEntry = failoverEventLog.find((e) => e.includes("[TRIGGER]") && e.includes(sessionID.slice(0, 16)));
      expect(triggerEntry).toBeDefined();
      expect(triggerEntry).toContain("source=message.updated");
      expect(triggerEntry).toContain("anthropic/claude-opus-4-6");
      expect(triggerEntry).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test("logs DISPATCH and DISPATCH_OK events on successful failover", async () => {
      const sessionID = "s-log-dispatch-ok";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-log-dispatch-ok",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };
      const { ctx } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      const dispatchEntry = failoverEventLog.find((e) => e.includes("[DISPATCH]") && !e.includes("DISPATCH_OK") && !e.includes("DISPATCH_ERROR") && e.includes(sessionID.slice(0, 16)));
      expect(dispatchEntry).toBeDefined();
      expect(dispatchEntry).toContain("to=amazon-bedrock/us.anthropic.claude-opus-4-6-v1");

      const okEntry = failoverEventLog.find((e) => e.includes("[DISPATCH_OK]") && e.includes(sessionID.slice(0, 16)));
      expect(okEntry).toBeDefined();
      expect(okEntry).toContain("to=amazon-bedrock/us.anthropic.claude-opus-4-6-v1");
      expect(okEntry).toMatch(/latency=\d+ms/);
    });

    test("logs DISPATCH_ERROR with error details when dispatch fails", async () => {
      const sessionID = "s-log-dispatch-error";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-log-dispatch-error",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };

      const promptCalls = [];
      const ctx = {
        directory: process.cwd(),
        client: {
          session: {
            messages: async ({ path }) => ({ data: messagesBySession[path.id] ?? [] }),
            prompt: async (request) => {
              if (request.body?.model?.providerID === "amazon-bedrock") {
                throw new Error("401 Unauthorized: invalid API key for bedrock");
              }
              promptCalls.push(request);
              return { data: {} };
            },
            abort: async () => ({ data: true })
          },
          tui: { showToast: async () => ({ data: true }) }
        }
      };
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      const errorEntry = failoverEventLog.find((e) => e.includes("[DISPATCH_ERROR]") && e.includes(sessionID.slice(0, 16)));
      expect(errorEntry).toBeDefined();
      expect(errorEntry).toContain("target=amazon-bedrock/us.anthropic.claude-opus-4-6-v1");
      expect(errorEntry).toContain("401 Unauthorized");
    });

    test("logs EXHAUSTED when all providers fail dispatch", async () => {
      const sessionID = "s-log-exhausted";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-log-exhausted",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };

      const ctx = {
        directory: process.cwd(),
        client: {
          session: {
            messages: async ({ path }) => ({ data: messagesBySession[path.id] ?? [] }),
            prompt: async () => { throw new Error("provider not configured"); },
            abort: async () => ({ data: true })
          },
          tui: { showToast: async () => ({ data: true }) }
        }
      };
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      const exhaustedEntry = failoverEventLog.find((e) => e.includes("[EXHAUSTED]") && e.includes(sessionID.slice(0, 16)));
      expect(exhaustedEntry).toBeDefined();
      expect(exhaustedEntry).toContain("tier=opus");
    });

    test("logs MANUAL event for manual failover via tool", async () => {
      const sessionID = "s-log-manual";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-log-manual",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
            text: "continue work"
          })
        ]
      };
      const { ctx } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.tool.failover_now.execute({}, makeToolContext(sessionID));

      const manualEntry = failoverEventLog.find((e) => e.includes("[MANUAL]") && e.includes(sessionID.slice(0, 16)));
      expect(manualEntry).toBeDefined();
      expect(manualEntry).toContain("to=amazon-bedrock/us.anthropic.claude-opus-4-6-v1");
    });

    test("writes log entries to failover.log file on disk", async () => {
      await withTempSettings(async (settingsPath) => {
        const logPath = settingsPath.replace("settings.json", "failover.log");
        const sessionID = "s-log-file";
        const messagesBySession = {
          [sessionID]: [
            makeUserMessage(sessionID, {
              id: "u-log-file",
              agent: "sisyphus",
              providerID: "anthropic",
              modelID: "claude-opus-4-6"
            }),
            makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
          ]
        };
        const { ctx } = createContext(messagesBySession);
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.event({
          event: {
            type: "message.updated",
            properties: { info: messagesBySession[sessionID][1].info }
          }
        });
        await hooks.event({
          event: { type: "session.idle", properties: { sessionID } }
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(existsSync(logPath)).toBe(true);
        const content = readFileSync(logPath, "utf8");
        expect(content).toContain("[TRIGGER]");
        expect(content).toContain("[DISPATCH]");
        expect(content).toContain("[DISPATCH_OK]");
        expect(content.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
      });
    });

    test("failover_status includes recent log entries", async () => {
      const sessionID = "s-log-status";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-log-status",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };
      const { ctx } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: { info: messagesBySession[sessionID][1].info }
        }
      });
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } }
      });

      const report = await hooks.tool.failover_status.execute(
        { sessionID },
        makeToolContext(sessionID)
      );

      expect(report).toContain("Recent events");
      expect(report).toContain("[TRIGGER]");
      expect(report).toContain("[DISPATCH_OK]");
      expect(report).toContain("Log file:");
    });
  });

  describe("Cooldown boundary and edge cases", () => {
    test("cross-session failover is blocked at 59,999ms within cooldown window", async () => {
      const sessionA = "cooldown-boundary-a";
      const sessionB = "cooldown-boundary-b";
      const messagesBySession = {
        [sessionA]: [
          makeUserMessage(sessionA, { id: "u-boundary-a", agent: "sisyphus", providerID: "anthropic", modelID: "claude-opus-4-6" }),
          makeAssistantErrorMessage(sessionA, "anthropic", "claude-opus-4-6", "insufficient_quota", 429, "a-boundary-a")
        ],
        [sessionB]: [
          makeUserMessage(sessionB, { id: "u-boundary-b", agent: "sisyphus", providerID: "anthropic", modelID: "claude-opus-4-6" }),
          makeAssistantErrorMessage(sessionB, "anthropic", "claude-opus-4-6", "insufficient_quota", 429, "a-boundary-b")
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);

      const realNow = Date.now;
      let now = 1_700_000_000_000;
      Date.now = () => now;
      try {
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionA][1].info } } });
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: sessionA } } });

        now += 59_999;

        await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionB][1].info } } });
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: sessionB } } });
      } finally {
        Date.now = realNow;
      }

      expect(promptCalls).toHaveLength(1);
      expect(promptCalls[0].path.id).toBe(sessionA);
    });

    test("cross-session failover is allowed after cooldown expiry at 60,001ms", async () => {
      const sessionA = "cooldown-expiry-a";
      const sessionB = "cooldown-expiry-b";
      const messagesBySession = {
        [sessionA]: [
          makeUserMessage(sessionA, { id: "u-expiry-a", agent: "sisyphus", providerID: "anthropic", modelID: "claude-opus-4-6" }),
          makeAssistantErrorMessage(sessionA, "anthropic", "claude-opus-4-6", "insufficient_quota", 429, "a-expiry-a")
        ],
        [sessionB]: [
          makeUserMessage(sessionB, { id: "u-expiry-b", agent: "sisyphus", providerID: "anthropic", modelID: "claude-opus-4-6" }),
          makeAssistantErrorMessage(sessionB, "anthropic", "claude-opus-4-6", "insufficient_quota", 429, "a-expiry-b")
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);

      const realNow = Date.now;
      let now = 1_700_000_100_000;
      Date.now = () => now;
      try {
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionA][1].info } } });
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: sessionA } } });

        now += 60_001;

        await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionB][1].info } } });
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: sessionB } } });
      } finally {
        Date.now = realNow;
      }

      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[0].path.id).toBe(sessionA);
      expect(promptCalls[1].path.id).toBe(sessionB);
    });

    test("same-session exemption allows cascading tier transitions during cooldown", async () => {
      const sessionID = "cooldown-cascade";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-cascade",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-sonnet-4-6", "insufficient_quota", 429, "a-cascade-1")
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionID][1].info } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: makeAssistantErrorMessage(
              sessionID,
              "amazon-bedrock",
              "us.anthropic.claude-sonnet-4-6",
              "insufficient_quota",
              429,
              "a-cascade-2"
            ).info
          }
        }
      });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[0].body.model).toEqual({
        providerID: "amazon-bedrock",
        modelID: "us.anthropic.claude-sonnet-4-6"
      });
      expect(promptCalls[1].body.model).toEqual({
        providerID: "openai",
        modelID: "gpt-5.3-codex"
      });
    });

    test("session.deleted clears state and allows fresh failover for same session ID", async () => {
      const sessionID = "deleted-cleanup";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-cleanup",
            agent: "sisyphus",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota", 429, "a-cleanup-1")
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionID][1].info } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      await hooks.event({ event: { type: "session.deleted", properties: { info: { id: sessionID } } } });

      messagesBySession[sessionID] = [
        makeUserMessage(sessionID, {
          id: "u-cleanup",
          agent: "sisyphus",
          providerID: "anthropic",
          modelID: "claude-opus-4-6"
        }),
        makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota", 429, "a-cleanup-2")
      ];

      await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionID][1].info } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[0].body.model.providerID).toBe("amazon-bedrock");
      expect(promptCalls[1].body.model.providerID).toBe("amazon-bedrock");
    });

    test("duplicate session.idle events are idempotent and dispatch only once", async () => {
      const sessionID = "idle-idempotent";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, { id: "u-idle-idempotent", providerID: "anthropic", modelID: "claude-opus-4-6" }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-opus-4-6", "insufficient_quota")
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionID][1].info } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      expect(promptCalls).toHaveLength(1);
    });
  });

  describe("session.error and chain exhaustion", () => {
    test("session.error with definitive quota error queues failover and dispatches on idle", async () => {
      const sessionID = "session-error-definitive";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-session-error-definitive",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          })
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "a-stats-definitive",
              sessionID,
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
              tokens: { input: 1000, output: 0, reasoning: 0 }
            }
          }
        }
      });

      await hooks.event({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "insufficient_quota" }
          }
        }
      });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      expect(promptCalls).toHaveLength(1);
      expect(promptCalls[0].body.model).toEqual({
        providerID: "amazon-bedrock",
        modelID: "us.anthropic.claude-opus-4-6-v1"
      });
    });

    test("session.error with ambiguous account rate limit does not queue failover", async () => {
      const sessionID = "session-error-ambiguous";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-session-error-ambiguous",
            providerID: "anthropic",
            modelID: "claude-opus-4-6"
          })
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "a-stats-ambiguous",
              sessionID,
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
              tokens: { input: 2000, output: 0 }
            }
          }
        }
      });

      await hooks.event({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: { message: "This request would exceed your account's rate limit. Please try again later." }
          }
        }
      });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      expect(promptCalls).toHaveLength(0);
    });

    test("haiku tier mapping is preserved from anthropic to bedrock", async () => {
      const sessionID = "haiku-tier-preserved";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-haiku-tier-preserved",
            providerID: "anthropic",
            modelID: "claude-haiku-4-5"
          }),
          makeAssistantErrorMessage(sessionID, "anthropic", "claude-haiku-4-5", "insufficient_quota")
        ]
      };
      const { ctx, promptCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionID][1].info } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      expect(promptCalls).toHaveLength(1);
      expect(promptCalls[0].body.model).toEqual({
        providerID: "amazon-bedrock",
        modelID: "us.anthropic.claude-haiku-4-5-20251001-v1:0"
      });
    });

    test("chain exhaustion shows no-additional-fallback toast without dispatch", async () => {
      const sessionID = "chain-exhaustion-no-fallback";
      const messagesBySession = {
        [sessionID]: [
          makeUserMessage(sessionID, {
            id: "u-chain-exhaustion",
            providerID: "amazon-bedrock",
            modelID: "us.anthropic.claude-opus-4-6-v1"
          }),
          makeAssistantErrorMessage(sessionID, "amazon-bedrock", "us.anthropic.claude-opus-4-6-v1", "insufficient_quota")
        ]
      };
      const { ctx, promptCalls, toastCalls } = createContext(messagesBySession);
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.tool.failover_set_providers.execute({ providers: ["amazon-bedrock"] }, makeToolContext(sessionID));
      await hooks.event({ event: { type: "message.updated", properties: { info: messagesBySession[sessionID][1].info } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

      expect(promptCalls).toHaveLength(0);
      const toast = toastCalls.find((call) =>
        call?.body?.title === "Model Failover" &&
        typeof call?.body?.message === "string" &&
        call.body.message.includes("No additional fallback model available")
      );
      expect(toast).toBeDefined();
    });

    test("missing settings file loads defaults gracefully", async () => {
      rmSync(TEST_SETTINGS_PATH, { force: true });
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const status = await hooks.tool.failover_status.execute({ sessionID: "" }, makeToolContext(""));
      expect(status).toContain("Provider chain: amazon-bedrock -> openai");
      expect(status).toContain("Debug toasts: on");
    });

    test("corrupt settings JSON loads defaults without crashing", async () => {
      writeFileSync(TEST_SETTINGS_PATH, "{ not valid json");
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const status = await hooks.tool.failover_status.execute({ sessionID: "" }, makeToolContext(""));
      expect(status).toContain("Provider chain: amazon-bedrock -> openai");
    });

    test("unknown provider entries are filtered from provider chain", async () => {
      writeFileSync(
        TEST_SETTINGS_PATH,
        JSON.stringify(
          {
            providerChain: ["amazon-bedrock", "fake-provider", "openai"],
            modelByProviderAndTier: {
              "amazon-bedrock": {
                opus: "us.anthropic.claude-opus-4-6-v1",
                sonnet: "us.anthropic.claude-sonnet-4-6",
                haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0"
              },
              openai: {
                opus: "gpt-5.4",
                sonnet: "gpt-5.3-codex",
                haiku: "gpt-5.2-codex"
              },
              anthropic: {
                opus: "claude-opus-4-6",
                sonnet: "claude-sonnet-4-6",
                haiku: "claude-haiku-4-5"
              }
            },
            debugToasts: true
          },
          null,
          2
        )
      );

      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);
      const status = await hooks.tool.failover_status.execute({ sessionID: "" }, makeToolContext(""));

      expect(status).toContain("Provider chain: amazon-bedrock -> openai");
      expect(status).not.toContain("fake-provider");
    });

    test("empty provider chain in settings keeps default provider chain", async () => {
      writeFileSync(
        TEST_SETTINGS_PATH,
        JSON.stringify(
          {
            providerChain: [],
            debugToasts: false,
            globalCooldownMs: 60_000
          },
          null,
          2
        )
      );

      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);
      const status = await hooks.tool.failover_status.execute({ sessionID: "" }, makeToolContext(""));

      expect(status).toContain("Provider chain: amazon-bedrock -> openai");
    });
  });

  describe("MCP tool edge cases", () => {
    test("failover_set_providers with all invalid providers returns an error", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const result = await hooks.tool.failover_set_providers.execute(
        { providers: ["fake1", "fake2"] },
        makeToolContext("tool-invalid-providers")
      );

      expect(result).toContain("No valid providers supplied");
    });

    test("failover_set_providers deduplicates provider entries before persisting", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const result = await hooks.tool.failover_set_providers.execute(
        { providers: ["openai", "openai", "amazon-bedrock"] },
        makeToolContext("tool-dedupe-providers")
      );

      expect(result).toContain("openai -> amazon-bedrock");

      const saved = JSON.parse(readFileSync(TEST_SETTINGS_PATH, "utf8"));
      expect(saved.providerChain).toEqual(["openai", "amazon-bedrock"]);
    });

    test("failover_set_model with allTiers=true sets all tiers for provider", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const result = await hooks.tool.failover_set_model.execute(
        {
          provider: "openai",
          modelID: "gpt-5.3-codex",
          allTiers: true
        },
        makeToolContext("tool-set-model-all-tiers")
      );

      expect(result).toContain("Updated tiers: opus, sonnet, haiku");

      const saved = JSON.parse(readFileSync(TEST_SETTINGS_PATH, "utf8"));
      expect(saved.modelByProviderAndTier.openai.opus).toBe("gpt-5.3-codex");
      expect(saved.modelByProviderAndTier.openai.sonnet).toBe("gpt-5.3-codex");
      expect(saved.modelByProviderAndTier.openai.haiku).toBe("gpt-5.3-codex");
    });

    test("failover_set_model with unknown model returns error", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const result = await hooks.tool.failover_set_model.execute(
        {
          provider: "openai",
          modelID: "gpt-5.999-unknown",
          tier: "sonnet"
        },
        makeToolContext("tool-unknown-model")
      );

      expect(result).toContain("Unknown model for provider openai");
    });

    test("failover_set_debug toggles enabled state in status report", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.tool.failover_set_debug.execute({ enabled: true }, makeToolContext("tool-debug-enable"));
      const statusEnabled = await hooks.tool.failover_status.execute({ sessionID: "" }, makeToolContext(""));
      expect(statusEnabled).toContain("Debug toasts: on");

      await hooks.tool.failover_set_debug.execute({ enabled: false }, makeToolContext("tool-debug-disable"));
      const statusDisabled = await hooks.tool.failover_status.execute({ sessionID: "" }, makeToolContext(""));
      expect(statusDisabled).toContain("Debug toasts: off");
    });

    test("failover_list_models without filter reports all providers", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const report = await hooks.tool.failover_list_models.execute({}, makeToolContext("tool-list-models-all"));
      expect(report).toContain("Provider: amazon-bedrock");
      expect(report).toContain("Provider: openai");
      expect(report).toContain("Provider: anthropic");
    });

    test("failover_list_models with provider filter returns only requested provider", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const report = await hooks.tool.failover_list_models.execute(
        { provider: "openai" },
        makeToolContext("tool-list-models-openai")
      );

      expect(report).toContain("Provider: openai");
      expect(report).not.toContain("Provider: amazon-bedrock");
      expect(report).not.toContain("Provider: anthropic");
    });

    test("failover_status with no active session returns non-error summary", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const report = await hooks.tool.failover_status.execute({ sessionID: "" }, makeToolContext(""));
      expect(report).toContain("Quota Failover Status");
      expect(report).toContain("Session: none selected");
      expect(report).toContain("Quota window note:");
    });

    test("failover_now with no replayable session context returns informative error", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      const result = await hooks.tool.failover_now.execute({}, makeToolContext("tool-failover-now-empty"));
      expect(result).toContain("Unable to run failover-now: no user message found to replay.");
    });

    test("failover_set_model persists selected mapping to settings.json", async () => {
      const { ctx } = createContext({});
      const hooks = await quotaFailoverPlugin(ctx);

      await hooks.tool.failover_set_model.execute(
        {
          provider: "amazon-bedrock",
          modelID: "moonshot.kimi-k2-thinking",
          tier: "sonnet"
        },
        makeToolContext("tool-persist-model")
      );

      const saved = JSON.parse(readFileSync(TEST_SETTINGS_PATH, "utf8"));
      expect(saved.modelByProviderAndTier["amazon-bedrock"].sonnet).toBe("moonshot.kimi-k2-thinking");
    });

    describe("failover_add_model", () => {
      test("registers a custom model and shows it in failover_list_models", async () => {
        const { ctx } = createContext({});
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.tool.failover_add_model.execute(
          {
            provider: "openai",
            modelID: "gpt-6-custom-alpha",
            tier: "opus",
            contextWindow: 777777
          },
          makeToolContext("tool-add-model-list")
        );

        const report = await hooks.tool.failover_list_models.execute(
          { provider: "openai" },
          makeToolContext("tool-add-model-list")
        );

        expect(report).toContain("Provider: openai");
        expect(report).toContain("gpt-6-custom-alpha");
      });

      test("registered custom model can be selected via failover_set_model", async () => {
        const { ctx } = createContext({});
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.tool.failover_add_model.execute(
          {
            provider: "openai",
            modelID: "gpt-6-custom-sonnet",
            tier: "sonnet"
          },
          makeToolContext("tool-add-model-set")
        );

        const result = await hooks.tool.failover_set_model.execute(
          {
            provider: "openai",
            modelID: "gpt-6-custom-sonnet",
            tier: "sonnet"
          },
          makeToolContext("tool-add-model-set")
        );

        expect(result).toContain("Failover model updated for openai.");

        const saved = JSON.parse(readFileSync(TEST_SETTINGS_PATH, "utf8"));
        expect(saved.modelByProviderAndTier.openai.sonnet).toBe("gpt-6-custom-sonnet");
      });

      test("custom model persists under customModels in settings.json", async () => {
        const { ctx } = createContext({});
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.tool.failover_add_model.execute(
          {
            provider: "anthropic",
            modelID: "claude-sonnet-9-custom",
            tier: "sonnet",
            contextWindow: 333333
          },
          makeToolContext("tool-add-model-persist")
        );

        const saved = JSON.parse(readFileSync(TEST_SETTINGS_PATH, "utf8"));
        const added = (saved.customModels ?? []).find(
          (entry) =>
            entry.provider === "anthropic" && entry.modelID === "claude-sonnet-9-custom"
        );

        expect(Array.isArray(saved.customModels)).toBe(true);
        expect(added).toEqual({
          provider: "anthropic",
          modelID: "claude-sonnet-9-custom",
          tier: "sonnet",
          contextWindow: 333333,
          isDefault: false
        });
      });

      test("duplicate custom model registration does not create duplicates", async () => {
        const { ctx } = createContext({});
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.tool.failover_add_model.execute(
          {
            provider: "openai",
            modelID: "gpt-6-dedupe",
            tier: "haiku"
          },
          makeToolContext("tool-add-model-dedupe")
        );

        await hooks.tool.failover_add_model.execute(
          {
            provider: "openai",
            modelID: "gpt-6-dedupe",
            tier: "haiku"
          },
          makeToolContext("tool-add-model-dedupe")
        );

        const saved = JSON.parse(readFileSync(TEST_SETTINGS_PATH, "utf8"));
        const matches = (saved.customModels ?? []).filter(
          (entry) => entry.provider === "openai" && entry.modelID === "gpt-6-dedupe"
        );
        expect(matches).toHaveLength(1);

        const report = await hooks.tool.failover_list_models.execute(
          { provider: "openai" },
          makeToolContext("tool-add-model-dedupe")
        );
        const occurrences = report.split("gpt-6-dedupe").length - 1;
        expect(occurrences).toBe(1);
      });

      test("setDefault=true updates provider tier mapping", async () => {
        const { ctx } = createContext({});
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.tool.failover_add_model.execute(
          {
            provider: "amazon-bedrock",
            modelID: "us.custom.bedrock-opus-x",
            tier: "opus",
            setDefault: true
          },
          makeToolContext("tool-add-model-default")
        );

        const saved = JSON.parse(readFileSync(TEST_SETTINGS_PATH, "utf8"));
        expect(saved.modelByProviderAndTier["amazon-bedrock"].opus).toBe("us.custom.bedrock-opus-x");

        const entry = (saved.customModels ?? []).find(
          (item) => item.provider === "amazon-bedrock" && item.modelID === "us.custom.bedrock-opus-x"
        );
        expect(entry?.isDefault).toBe(true);
      });

      test("custom tier is inferred by failover_set_model when tier argument is omitted", async () => {
        const { ctx } = createContext({});
        const hooks = await quotaFailoverPlugin(ctx);

        await hooks.tool.failover_add_model.execute(
          {
            provider: "openai",
            modelID: "gpt-6-infer-sonnet",
            tier: "sonnet"
          },
          makeToolContext("tool-add-model-infer")
        );

        const result = await hooks.tool.failover_set_model.execute(
          {
            provider: "openai",
            modelID: "gpt-6-infer-sonnet"
          },
          makeToolContext("tool-add-model-infer")
        );

        expect(result).toContain("Updated tiers: sonnet");

        const saved = JSON.parse(readFileSync(TEST_SETTINGS_PATH, "utf8"));
        expect(saved.modelByProviderAndTier.openai.sonnet).toBe("gpt-6-infer-sonnet");
      });

      test("custom models survive plugin reload", async () => {
        await withTempSettings(async () => {
          const { ctx } = createContext({});
          const hooks = await quotaFailoverPlugin(ctx);

          await hooks.tool.failover_add_model.execute(
            {
              provider: "openai",
              modelID: "gpt-6-reload",
              tier: "opus",
              contextWindow: 888888
            },
            makeToolContext("tool-add-model-reload")
          );

          const { ctx: ctxReloaded } = createContext({});
          const hooksReloaded = await quotaFailoverPlugin(ctxReloaded);

          const report = await hooksReloaded.tool.failover_list_models.execute(
            { provider: "openai" },
            makeToolContext("tool-add-model-reload")
          );
          expect(report).toContain("gpt-6-reload");

          const setResult = await hooksReloaded.tool.failover_set_model.execute(
            {
              provider: "openai",
              modelID: "gpt-6-reload",
              tier: "opus"
            },
            makeToolContext("tool-add-model-reload")
          );
          expect(setResult).toContain("Failover model updated for openai.");
        });
      });
    });
  });

});
