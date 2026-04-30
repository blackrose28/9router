import { describe, it, expect } from "vitest";
import { injectReasoningContent } from "../../open-sse/utils/reasoningContentInjector.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runPassthrough(input) {
  const stream = createPassthroughStreamWithLogger("opencode-go", null, "deepseek-v4-pro", "conn-test", {}, null, null);
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const readAll = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  })();

  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  return readAll;
}

describe("OpenCode Go hardening", () => {
  describe("reasoning_content injection", () => {
    it("preserves real reasoning_content on DeepSeek assistant tool-call messages", () => {
      const body = {
        messages: [
          {
            role: "assistant",
            content: null,
            reasoning_content: "Real reasoning from upstream.",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }]
          }
        ]
      };

      const result = injectReasoningContent({ provider: "opencode-go", model: "deepseek-v4-pro", body });

      expect(result.messages[0].reasoning_content).toBe("Real reasoning from upstream.");
    });

    it("uses placeholder fallback for DeepSeek assistant tool-call messages without real reasoning", () => {
      const body = {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }]
          }
        ]
      };

      const result = injectReasoningContent({ provider: "opencode-go", model: "deepseek-v4-pro", body });

      expect(result.messages[0].reasoning_content).toBe(" ");
    });

    it("does not add placeholder reasoning_content to non-tool DeepSeek assistant messages", () => {
      const body = {
        messages: [
          { role: "assistant", content: "Previous plain assistant answer." }
        ]
      };

      const result = injectReasoningContent({ provider: "opencode-go", model: "deepseek-v4-pro", body });

      expect(result.messages[0]).not.toHaveProperty("reasoning_content");
    });
  });

  describe("passthrough stream DONE handling", () => {
    it("does not append a second [DONE] when upstream already sent one", async () => {
      const output = await runPassthrough([
        'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        "",
        "data: [DONE]",
        ""
      ].join("\n"));

      expect(output.match(/data:\s*\[DONE\]/g)).toHaveLength(1);
    });

    it("appends [DONE] when upstream closes without one", async () => {
      const output = await runPassthrough([
        'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        ""
      ].join("\n"));

      expect(output.match(/data:\s*\[DONE\]/g)).toHaveLength(1);
    });
  });
});
