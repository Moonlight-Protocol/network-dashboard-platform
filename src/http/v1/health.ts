import { Router, Status } from "@oak/oak";
import { getWatcherHealth } from "@/core/sync/soroban-watcher.ts";

const denoJson = JSON.parse(
  await Deno.readTextFile(new URL("../../../deno.json", import.meta.url)),
);
const version: string = denoJson.version ?? "unknown";

export const healthRouter = new Router();

healthRouter.get("/health", (ctx) => {
  const watcher = getWatcherHealth();
  // Stranded = the forward poller is running but was never armed with a
  // cursor (cold-start failed). It ingests nothing, so the dashboard is
  // effectively dead while looking up. Report 503 so the Fly health check
  // restarts the machine (re-running cold-start) instead of serving a frozen
  // dashboard behind a green endpoint — the failure mode that hid this for
  // weeks. NOTE: if cold-start fails persistently this turns into a restart
  // loop (visible + alerting, which is the point); dial back to a body-only
  // `degraded` flag here if flapping is worse than a frozen-but-up dashboard.
  const stranded = watcher.running && !watcher.armed;
  ctx.response.status = stranded ? Status.ServiceUnavailable : Status.OK;
  ctx.response.body = {
    status: stranded ? "degraded" : "ok",
    service: "network-dashboard-platform",
    version,
    watcher,
  };
});
