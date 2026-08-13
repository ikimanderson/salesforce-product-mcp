import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { safeEqual, extractToken, isAuthorized } from "@/lib/auth";

describe("safeEqual", () => {
  it("returns true for equal strings", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for unequal strings of the same length", () => {
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(safeEqual("short", "a-lot-longer")).toBe(false);
  });
});

describe("extractToken", () => {
  it("reads a Bearer token from the Authorization header", () => {
    const req = new Request("https://example.com/api/mcp", {
      headers: { Authorization: "Bearer tok-abc" },
    });
    expect(extractToken(req)).toBe("tok-abc");
  });

  it("ignores non-Bearer Authorization headers", () => {
    const req = new Request("https://example.com/api/mcp", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractToken(req)).toBeUndefined();
  });

  it("falls back to a ?token= query param", () => {
    const req = new Request("https://example.com/api/mcp?token=tok-xyz");
    expect(extractToken(req)).toBe("tok-xyz");
  });

  it("falls back to a ?key= query param", () => {
    const req = new Request("https://example.com/api/mcp?key=tok-key");
    expect(extractToken(req)).toBe("tok-key");
  });

  it("returns undefined when no token is present anywhere", () => {
    const req = new Request("https://example.com/api/mcp");
    expect(extractToken(req)).toBeUndefined();
  });
});

describe("isAuthorized", () => {
  const ORIGINAL_TOKEN = process.env.MCP_BEARER_TOKEN;

  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = "correct-token";
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.MCP_BEARER_TOKEN;
    } else {
      process.env.MCP_BEARER_TOKEN = ORIGINAL_TOKEN;
    }
  });

  it("accepts a request with the correct bearer header", () => {
    const req = new Request("https://example.com/api/mcp", {
      headers: { Authorization: "Bearer correct-token" },
    });
    expect(isAuthorized(req)).toBe(true);
  });

  it("accepts a request with the correct token as a query param", () => {
    const req = new Request("https://example.com/api/mcp?token=correct-token");
    expect(isAuthorized(req)).toBe(true);
  });

  it("rejects a request with an incorrect token", () => {
    const req = new Request("https://example.com/api/mcp", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(isAuthorized(req)).toBe(false);
  });

  it("rejects a request with no token at all", () => {
    const req = new Request("https://example.com/api/mcp");
    expect(isAuthorized(req)).toBe(false);
  });

  it("fails closed when MCP_BEARER_TOKEN is not configured", () => {
    delete process.env.MCP_BEARER_TOKEN;
    const req = new Request("https://example.com/api/mcp", {
      headers: { Authorization: "Bearer correct-token" },
    });
    expect(isAuthorized(req)).toBe(false);
  });
});
