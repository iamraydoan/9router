import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const {
  markAccountUnavailable,
} = await import("../../src/sse/services/auth.js");
const {
  pickProxyPoolId,
  advanceFailoverPool,
  getFailoverIndex,
} = await import("../../src/lib/network/connectionProxy.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("failover-429 proxy cursor", () => {
  it("sticks to the current pool until advanced", () => {
    const pools = ["p1", "p2", "p3"];
    expect(pickProxyPoolId(pools, "failover-429", "prov-stick", "primary")).toBe("p1");
    expect(pickProxyPoolId(pools, "failover-429", "prov-stick")).toBe("p1");

    expect(advanceFailoverPool(pools.length, "prov-stick")).toBe(true);
    expect(pickProxyPoolId(pools, "failover-429", "prov-stick")).toBe("p2");
  });

  it("returns false once every pool has struck once", () => {
    const pools = ["p1", "p2"];
    pickProxyPoolId(pools, "failover-429", "prov-exhaust", "primary");
    expect(advanceFailoverPool(pools.length, "prov-exhaust")).toBe(true);
    expect(advanceFailoverPool(pools.length, "prov-exhaust")).toBe(false);
  });

  it("resets the strike counter on a primary pick", () => {
    const pools = ["p1", "p2", "p3"];
    pickProxyPoolId(pools, "failover-429", "prov-reset", "primary");
    advanceFailoverPool(pools.length, "prov-reset");
    advanceFailoverPool(pools.length, "prov-reset");
    pickProxyPoolId(pools, "failover-429", "prov-reset", "primary");
    expect(advanceFailoverPool(pools.length, "prov-reset")).toBe(true);
  });
});

describe("markAccountUnavailable noauth failover", () => {
  it("advances the cursor on 429 and asks the caller to fall back", async () => {
    dbMocks.getSettings.mockResolvedValue({
      providerStrategies: { "opencode-fo": { rotateStrategy: "failover-429" } },
    });
    dbMocks.getProxyPools.mockResolvedValue([
      { id: "p1", proxyUrl: "http://p1:8080", isActive: true },
      { id: "p2", proxyUrl: "http://p2:8080", isActive: true },
      { id: "p3", proxyUrl: "http://p3:8080", isActive: true },
    ]);

    pickProxyPoolId(["p1", "p2", "p3"], "failover-429", "opencode-fo", "primary");

    const r1 = await markAccountUnavailable(undefined, 429, "FreeUsageLimitError", "opencode-fo", "model-x");
    expect(r1.shouldFallback).toBe(true);
    expect(getFailoverIndex("opencode-fo")).toBe(1);

    const r2 = await markAccountUnavailable(undefined, 429, "FreeUsageLimitError", "opencode-fo", "model-x");
    expect(r2.shouldFallback).toBe(true);
    expect(getFailoverIndex("opencode-fo")).toBe(2);

    const r3 = await markAccountUnavailable(undefined, 429, "FreeUsageLimitError", "opencode-fo", "model-x");
    expect(r3.shouldFallback).toBe(false);
  });

  it("does not advance on non-429 statuses", async () => {
    dbMocks.getSettings.mockResolvedValue({
      providerStrategies: { "opencode-fo": { rotateStrategy: "failover-429" } },
    });
    dbMocks.getProxyPools.mockResolvedValue([
      { id: "p1", proxyUrl: "http://p1:8080", isActive: true },
      { id: "p2", proxyUrl: "http://p2:8080", isActive: true },
    ]);
    pickProxyPoolId(["p1", "p2"], "failover-429", "opencode-fo", "primary");
    const before = getFailoverIndex("opencode-fo");

    const r = await markAccountUnavailable(undefined, 400, "encrypted_content", "opencode-fo", "model-x");
    expect(r.shouldFallback).toBe(false);
    expect(getFailoverIndex("opencode-fo")).toBe(before);
  });

  it("stays put when the strategy is not failover-429", async () => {
    dbMocks.getSettings.mockResolvedValue({
      providerStrategies: { "opencode-fo": { rotateStrategy: "round-robin" } },
    });
    const r = await markAccountUnavailable(undefined, 429, "FreeUsageLimitError", "opencode-fo", "model-x");
    expect(r.shouldFallback).toBe(false);
    expect(dbMocks.getProxyPools).not.toHaveBeenCalled();
  });
});
