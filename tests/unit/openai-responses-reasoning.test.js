import { describe, it, expect } from "vitest";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/helpers/responsesApiHelper.js";

const reasoningItem = {
  type: "reasoning",
  id: "rs_123",
  summary: [{ type: "summary_text", text: "Need to inspect files before answering." }]
};

const functionCallItem = {
  type: "function_call",
  call_id: "call_123",
  name: "read_file",
  arguments: '{"path":"package.json"}'
};

const toolOutputItem = {
  type: "function_call_output",
  call_id: "call_123",
  output: "{\"name\":\"9router-app\"}"
};

describe("Responses API reasoning preservation", () => {
  it("preserves reasoning_content on assistant tool-call messages when translating to Chat Completions", () => {
    const result = openaiResponsesToOpenAIRequest("deepseek-v4-pro", {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Check project name" }] },
        reasoningItem,
        functionCallItem,
        toolOutputItem
      ]
    });

    const assistant = result.messages.find((msg) => msg.role === "assistant");

    expect(assistant).toBeDefined();
    expect(assistant.reasoning_content).toBe("Need to inspect files before answering.");
    expect(assistant.tool_calls).toHaveLength(1);
    expect(result.messages.find((msg) => msg.role === "tool")?.tool_call_id).toBe("call_123");
  });

  it("does not leak prior reasoning_content into later assistant tool-call messages", () => {
    const result = openaiResponsesToOpenAIRequest("deepseek-v4-pro", {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Do two steps" }] },
        reasoningItem,
        functionCallItem,
        toolOutputItem,
        { type: "reasoning", summary: [{ type: "summary_text", text: "Now inspect README." }] },
        { type: "function_call", call_id: "call_456", name: "read_file", arguments: '{"path":"README.md"}' },
        { type: "function_call_output", call_id: "call_456", output: "readme" }
      ]
    });

    const assistants = result.messages.filter((msg) => msg.role === "assistant");

    expect(assistants).toHaveLength(2);
    expect(assistants[0].reasoning_content).toBe("Need to inspect files before answering.");
    expect(assistants[1].reasoning_content).toBe("Now inspect README.");
  });

  it("preserves reasoning_content in the helper converter used by /responses", () => {
    const result = convertResponsesApiFormat({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Check project name" }] },
        reasoningItem,
        functionCallItem,
        toolOutputItem
      ]
    });

    const assistant = result.messages.find((msg) => msg.role === "assistant");

    expect(assistant).toBeDefined();
    expect(assistant.reasoning_content).toBe("Need to inspect files before answering.");
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it("keeps reasoning_content on mixed assistant content plus tool-call turns", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Pick a direction" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "Need to ask for clarification." }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Bạn muốn triển khai hướng nào?" }]
        },
        {
          type: "function_call",
          call_id: "call_ask",
          name: "request_user_input",
          arguments: "{\"questions\":[]}"
        },
        { type: "function_call_output", call_id: "call_ask", output: "request_user_input is unavailable" }
      ]
    };
    const result = openaiResponsesToOpenAIRequest("deepseek-v4-pro", body);
    const helperResult = convertResponsesApiFormat(body);

    const assistant = result.messages.find((msg) => msg.role === "assistant");
    const helperAssistant = helperResult.messages.find((msg) => msg.role === "assistant");

    expect(result.messages.filter((msg) => msg.role === "assistant")).toHaveLength(1);
    expect(assistant.content).toEqual([{ type: "text", text: "Bạn muốn triển khai hướng nào?" }]);
    expect(assistant.reasoning_content).toBe("Need to ask for clarification.");
    expect(assistant.tool_calls).toHaveLength(1);
    expect(helperAssistant).toEqual(assistant);
  });
});
