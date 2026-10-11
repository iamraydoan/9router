import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode.js";

function creds(overrides = {}) {
  return { connectionId: "conn_test", rawHeaders: {}, ...overrides };
}

function prepared(credentials, body = { messages: [{ role: "user", content: "hello" }] }) {
  const executor = getExecutor("opencode");
  return executor.prepareRequestCredentials({
    body,
    credentials,
    providerSessionId: "conversation-a",
    clientTool: "claude",
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
});

describe("OpenCode proxy bucket binding", () => {
  it("is stable when no proxy is configured", () => {
    const a = prepared(creds())._opencodeSession;
    const b = prepared(creds())._opencodeSession;
    expect(a).toMatch(OPENCODE_SESSION_RE);
    expect(a).toBe(b);
  });

  it("changes the session when the proxy pool changes", () => {
    const base = { connectionId: "conn_test", rawHeaders: {} };
    const a = prepared({ ...base, providerSpecificData: { connectionProxyPoolId: "pool-a" } })._opencodeSession;
    const b = prepared({ ...base, providerSpecificData: { connectionProxyPoolId: "pool-b" } })._opencodeSession;
    expect(a).not.toBe(b);
    expect(a).toMatch(OPENCODE_SESSION_RE);
  });

  it("changes the session when only the proxy URL changes", () => {
    const base = {
      connectionId: "conn_test",
      rawHeaders: {},
      providerSpecificData: { connectionProxyEnabled: true },
    };
    const a = prepared({ ...base, providerSpecificData: { ...base.providerSpecificData, connectionProxyUrl: "http://p1:8080" } })._opencodeSession;
    const b = prepared({ ...base, providerSpecificData: { ...base.providerSpecificData, connectionProxyUrl: "http://p2:8080" } })._opencodeSession;
    expect(a).not.toBe(b);
  });

  it("never leaks the raw downstream session to the wire", () => {
    const raw = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const out = prepared(creds({ rawHeaders: { "x-opencode-session": raw } }))._opencodeSession;
    expect(out).not.toBe(raw);
    expect(out).toMatch(OPENCODE_SESSION_RE);
  });

  it("uses the pool id over the url when both are present", () => {
    const pool = prepared(creds({
      providerSpecificData: { connectionProxyPoolId: "pool-a", connectionProxyEnabled: true, connectionProxyUrl: "http://p1:8080" },
    }))._opencodeSession;
    const samePoolDifferentUrl = prepared(creds({
      providerSpecificData: { connectionProxyPoolId: "pool-a", connectionProxyEnabled: true, connectionProxyUrl: "http://p2:8080" },
    }))._opencodeSession;
    expect(pool).toBe(samePoolDifferentUrl);
  });

  it("never echoes a downstream x-opencode-request in buildHeaders", () => {
    const executor = getExecutor("opencode");
    const raw = "msg_0ae8d9cd3001swxaFbM248jcIF";
    const headers = executor.buildHeaders({
      connectionId: "conn_test",
      rawHeaders: { "x-opencode-request": raw },
    });
    expect(headers["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(headers["x-opencode-request"]).not.toBe(raw);
  });
});
