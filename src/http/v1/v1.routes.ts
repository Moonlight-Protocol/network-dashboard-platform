import { Router } from "@oak/oak";
import type { Logger } from "@/utils/logger/index.ts";
import type { NetworkEventBus } from "@/core/events/bus.ts";
import { healthRouter } from "./health.ts";
import { buildNetworkWsRouter } from "./network-ws.ts";
import { buildPublicRpcRouter } from "./public-rpc.ts";

export function buildApiRouter(
  deps: { log: Logger; bus: NetworkEventBus },
): Router {
  const apiRouter = new Router();
  const networkWsRouter = buildNetworkWsRouter(deps);
  const publicRpcRouter = buildPublicRpcRouter(deps);

  apiRouter.use(
    "/api/v1",
    healthRouter.routes(),
    healthRouter.allowedMethods(),
  );
  apiRouter.use(
    "/api/v1",
    networkWsRouter.routes(),
    networkWsRouter.allowedMethods(),
  );
  apiRouter.use(
    "/api/v1",
    publicRpcRouter.routes(),
    publicRpcRouter.allowedMethods(),
  );

  return apiRouter;
}
