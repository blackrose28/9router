import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { COOLDOWN_MS, HTTP_STATUS } from "../../open-sse/config/runtimeConfig.js";

describe("checkFallbackError classification", () => {
  it("treats quota exhaustion messages as fallback with quota cooldown", () => {
    const result = checkFallbackError(
      HTTP_STATUS.FORBIDDEN,
      "You exceeded your current quota. Please check your billing details.",
      0,
      null
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(COOLDOWN_MS.quotaExhausted);
  });

  it("uses retryAfterMs when quota exhaustion includes reset header", () => {
    const result = checkFallbackError(
      HTTP_STATUS.RATE_LIMITED,
      "insufficient_quota",
      0,
      120000
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(120000);
    expect(result.newBackoffLevel).toBe(0);
  });

  it("does not fallback for unknown client 4xx request errors", () => {
    const result = checkFallbackError(
      HTTP_STATUS.BAD_REQUEST,
      "Invalid request payload format",
      0,
      null
    );

    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("still falls back for auth errors", () => {
    const result = checkFallbackError(
      HTTP_STATUS.UNAUTHORIZED,
      "invalid auth token",
      0,
      null
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(COOLDOWN_MS.unauthorized);
  });
});
