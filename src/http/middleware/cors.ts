import type { Context, Next } from "@oak/oak";
import { getAllowedOrigins, getMode } from "@/config/env.ts";

const LOCALHOST_ORIGIN = /^https?:\/\/localhost(:\d+)?$/;

function isAllowed(origin: string): boolean {
  if (getAllowedOrigins().includes(origin)) return true;
  if (getMode() === "development" && LOCALHOST_ORIGIN.test(origin)) return true;
  return false;
}

function setCorsHeaders(ctx: Context, origin: string) {
  ctx.response.headers.set("Access-Control-Allow-Origin", origin);
  ctx.response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS",
  );
  ctx.response.headers.set(
    "Access-Control-Allow-Headers",
    getMode() === "development" ? "*" : "Content-Type, Traceparent, Tracestate",
  );
  ctx.response.headers.set("Access-Control-Max-Age", "86400");
}

export async function corsMiddleware(ctx: Context, next: Next) {
  const origin = ctx.request.headers.get("Origin");
  const allowed = !!origin && isAllowed(origin);

  if (ctx.request.method === "OPTIONS" && allowed) {
    setCorsHeaders(ctx, origin!);
    ctx.response.status = 204;
    return;
  }

  try {
    await next();
  } finally {
    if (allowed) {
      setCorsHeaders(ctx, origin!);
    }
  }
}
