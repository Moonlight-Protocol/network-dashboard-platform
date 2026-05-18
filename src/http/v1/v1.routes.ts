import { Router } from "@oak/oak";
import { healthRouter } from "./health.ts";
import { networkWsRouter } from "./network-ws.ts";

const apiRouter = new Router();

apiRouter.use("/api/v1", healthRouter.routes(), healthRouter.allowedMethods());
apiRouter.use(
  "/api/v1",
  networkWsRouter.routes(),
  networkWsRouter.allowedMethods(),
);

export default apiRouter;
