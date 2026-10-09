import express from "express";
import { router } from "./router.js";

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

export function start() {
  const app = createServer();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`porchlight-server listening on :${port}`);
  });
}
