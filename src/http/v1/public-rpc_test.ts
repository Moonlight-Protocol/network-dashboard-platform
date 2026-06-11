// deno-lint-ignore-file no-explicit-any -- mock Oak context is intentionally loose
/**
 * Tests for the public, read-only Soroban RPC passthrough proxy.
 *
 * Covers: allowlisted forward, non-allowlisted reject, faithful upstream-error
 * relay, and per-IP rate-limiting (429).
 */
import { assertEquals } from "@std/assert";
import { newNoop } from "@/utils/logger/index.ts";
import { __resetEnvCacheForTests } from "@/config/env.ts";
import { handlePublicRpc } from "./public-rpc.ts";

Deno.env.set("STELLAR_RPC_URL", "http://upstream.local/rpc");
__resetEnvCacheForTests();

type MockResponse = { status: number; body: unknown };

function mockCtx(
  opts: { body?: unknown; ip?: string; headers?: Record<string, string> },
): {
  ctx: any;
  getResponse: () => MockResponse;
} {
  let status = 200;
  let body: unknown = undefined;
  const ctx = {
    request: {
      headers: new Headers(opts.headers ?? {}),
      ip: opts.ip ?? "127.0.0.1",
      body: {
        json: () =>
          opts.body === undefined
            ? Promise.reject(new SyntaxError("no body"))
            : Promise.resolve(opts.body),
      },
    },
    response: {
      get status() {
        return status;
      },
      set status(s: number) {
        status = s;
      },
      get body() {
        return body;
      },
      set body(b: unknown) {
        body = b;
      },
      headers: { set: (_k: string, _v: string) => {} },
    },
  };
  return { ctx, getResponse: () => ({ status, body }) };
}

function stubFetch(
  responder: (url: string, body: string) => Response,
): { calls: number; restore: () => void } {
  const state = { calls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    state.calls++;
    return Promise.resolve(responder(String(input), String(init?.body ?? "")));
  }) as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    restore: () => (globalThis.fetch = original),
  };
}

Deno.test("public/rpc - forwards an allowlisted read method and relays the response", async () => {
  const upstream = { jsonrpc: "2.0", id: 1, result: { sequence: 99 } };
  let sentTo = "";
  const fetchStub = stubFetch((url) => {
    sentTo = url;
    return new Response(JSON.stringify(upstream), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const { ctx, getResponse } = mockCtx({
      body: { jsonrpc: "2.0", id: 1, method: "getLatestLedger" },
    });
    await handlePublicRpc({ log: newNoop() })(ctx);

    const res = getResponse();
    assertEquals(res.status, 200);
    assertEquals(res.body, upstream);
    assertEquals(sentTo, "http://upstream.local/rpc");
    assertEquals(fetchStub.calls, 1);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("public/rpc - rejects a write method (sendTransaction) without hitting upstream", async () => {
  const fetchStub = stubFetch(() => new Response("nope", { status: 200 }));
  try {
    const { ctx, getResponse } = mockCtx({
      body: { jsonrpc: "2.0", id: 2, method: "sendTransaction" },
    });
    await handlePublicRpc({ log: newNoop() })(ctx);

    const res = getResponse();
    assertEquals(res.status, 200);
    assertEquals((res.body as any).error.code, -32601);
    assertEquals(fetchStub.calls, 0);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("public/rpc - relays an upstream error response faithfully", async () => {
  const upstreamErr = {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32602, message: "Invalid params" },
  };
  const fetchStub = stubFetch(() =>
    new Response(JSON.stringify(upstreamErr), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  try {
    const { ctx, getResponse } = mockCtx({
      body: { jsonrpc: "2.0", id: 5, method: "getLedgerEntries" },
    });
    await handlePublicRpc({ log: newNoop() })(ctx);

    const res = getResponse();
    assertEquals(res.status, 200);
    assertEquals(res.body, upstreamErr);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("public/rpc - rate-limits a single IP past the configured ceiling", async () => {
  Deno.env.set("PUBLIC_RPC_RATE_LIMIT", "2");
  const fetchStub = stubFetch(() =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  try {
    const handler = handlePublicRpc({ log: newNoop() });
    const call = () => {
      const { ctx, getResponse } = mockCtx({
        body: { jsonrpc: "2.0", id: 1, method: "getAccount" },
        headers: { "fly-client-ip": "203.0.113.7" },
      });
      return handler(ctx).then(() => getResponse());
    };

    assertEquals((await call()).status, 200);
    assertEquals((await call()).status, 200);
    const limited = await call();
    assertEquals(limited.status, 429);
    assertEquals((limited.body as any).error.code, -32005);
    // Only the two allowed calls reached upstream.
    assertEquals(fetchStub.calls, 2);
  } finally {
    fetchStub.restore();
    Deno.env.delete("PUBLIC_RPC_RATE_LIMIT");
  }
});
