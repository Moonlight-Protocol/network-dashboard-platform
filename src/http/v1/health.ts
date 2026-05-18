import { Router, Status } from "@oak/oak";

const denoJson = JSON.parse(
  await Deno.readTextFile(new URL("../../../deno.json", import.meta.url)),
);
const version: string = denoJson.version ?? "unknown";

export const healthRouter = new Router();

healthRouter.get("/health", (ctx) => {
  ctx.response.status = Status.OK;
  ctx.response.body = {
    status: "ok",
    service: "network-dashboard-platform",
    version,
  };
});
