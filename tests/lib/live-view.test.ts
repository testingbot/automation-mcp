import { describe, it, expect, vi } from "vitest";
import { buildLiveViewUrl } from "../../src/lib/live-view.js";

describe("buildLiveViewUrl", () => {
  it("uses the testingbot-api auth hash and URL-encodes the sessionId", () => {
    const api = {
      getAuthenticationHashForSharing: vi.fn().mockReturnValue("deadbeef"),
    };
    const url = buildLiveViewUrl(api, "abc-123");
    expect(api.getAuthenticationHashForSharing).toHaveBeenCalledWith("abc-123");
    expect(url).toBe("https://testingbot.com/tests/abc-123/live?auth=deadbeef");
  });

  it("URL-encodes session IDs containing reserved characters", () => {
    const api = { getAuthenticationHashForSharing: () => "x" };
    const url = buildLiveViewUrl(api, "weird id/with/slash");
    expect(url).toContain(encodeURIComponent("weird id/with/slash"));
    expect(url).not.toContain("weird id/with/slash"); // raw form must be gone
  });

  it("preserves the exact hash returned by the API (no transformation)", () => {
    const api = { getAuthenticationHashForSharing: () => "ABCdef0123456789" };
    const url = buildLiveViewUrl(api, "s1");
    expect(url.endsWith("auth=ABCdef0123456789")).toBe(true);
  });
});
