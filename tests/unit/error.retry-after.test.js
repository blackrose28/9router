import { describe, it, expect } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

describe("parseUpstreamError retry-after parsing", () => {
  it("parses Retry-After seconds header", async () => {
    const response = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "120",
      },
    });

    const result = await parseUpstreamError(response, "codex");
    expect(result.statusCode).toBe(429);
    expect(result.retryAfterMs).toBe(120000);
  });

  it("parses x-ratelimit-reset epoch header", async () => {
    const futureTsSec = Math.floor((Date.now() + 90000) / 1000);
    const response = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "x-ratelimit-reset": String(futureTsSec),
      },
    });

    const result = await parseUpstreamError(response, "codex");
    expect(result.statusCode).toBe(429);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("returns null retryAfterMs when no reset headers are present", async () => {
    const response = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = await parseUpstreamError(response, "codex");
    expect(result.retryAfterMs).toBeNull();
  });
});
