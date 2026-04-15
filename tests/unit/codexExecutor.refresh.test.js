import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshCodexToken: vi.fn(),
}));

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { refreshCodexToken } from "../../open-sse/services/tokenRefresh.js";

describe("CodexExecutor.refreshCredentials", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when refresh token is missing", async () => {
    const executor = new CodexExecutor();
    const result = await executor.refreshCredentials({ accessToken: "at-old" }, log);

    expect(result).toBeNull();
    expect(refreshCodexToken).not.toHaveBeenCalled();
  });

  it("returns normalized refreshed credentials when refresh succeeds", async () => {
    vi.mocked(refreshCodexToken).mockResolvedValueOnce({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresIn: 3600,
    });

    const executor = new CodexExecutor();
    const result = await executor.refreshCredentials({ refreshToken: "rt-old" }, log);

    expect(refreshCodexToken).toHaveBeenCalledWith("rt-old", log);
    expect(result).toEqual({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresIn: 3600,
    });
  });

  it("keeps existing refresh token when provider response omits refreshToken", async () => {
    vi.mocked(refreshCodexToken).mockResolvedValueOnce({
      accessToken: "at-new",
      expiresIn: 1800,
    });

    const executor = new CodexExecutor();
    const result = await executor.refreshCredentials({ refreshToken: "rt-old" }, log);

    expect(result).toEqual({
      accessToken: "at-new",
      refreshToken: "rt-old",
      expiresIn: 1800,
    });
  });

  it("returns null when refresh fails", async () => {
    vi.mocked(refreshCodexToken).mockResolvedValueOnce(null);

    const executor = new CodexExecutor();
    const result = await executor.refreshCredentials({ refreshToken: "rt-old" }, log);

    expect(result).toBeNull();
  });
});
