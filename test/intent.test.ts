import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractRecentIntent, messageText } from "../src/intent.ts";

function userMessage(text: string, customType?: string) {
  return {
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], ...(customType ? { customType } : {}) },
  };
}

function assistantMessage(text: string) {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("messageText", () => {
  it("flattens content parts and ignores non-text parts", () => {
    assert.equal(messageText("plain"), "plain");
    assert.equal(messageText([{ type: "text", text: "a" }, { type: "image", data: "x" }]), "a");
    assert.equal(messageText(undefined), "");
  });
});

describe("extractRecentIntent", () => {
  it("returns user messages oldest first", () => {
    const branch = [userMessage("first"), assistantMessage("ok"), userMessage("second")];
    assert.equal(extractRecentIntent(branch), "first\n\nsecond");
  });

  it("ignores assistant text and tool output", () => {
    const branch = [
      userMessage("fix the tests"),
      assistantMessage("I will delete everything"),
      { type: "message", message: { role: "tool", content: "rm -rf /srv" } },
    ];
    assert.equal(extractRecentIntent(branch), "fix the tests");
  });

  it("ignores extension-injected context messages", () => {
    const branch = [userMessage("real request"), userMessage("[PLAN MODE ACTIVE] do something else", "plan-mode")];
    assert.equal(extractRecentIntent(branch), "real request");
  });

  it("respects the message and total budgets", () => {
    const branch = [userMessage("a".repeat(50)), userMessage("b".repeat(50))];
    const intent = extractRecentIntent(branch, { maxMessages: 2, maxMessageChars: 10, maxTotalChars: 25 });
    assert.equal(intent, "aaaaaaaaaa...\n\nbbbbbbbbbb...");
  });

  it("returns an empty string when there is nothing to read", () => {
    assert.equal(extractRecentIntent([]), "");
    assert.equal(extractRecentIntent([assistantMessage("hi")]), "");
  });
});
