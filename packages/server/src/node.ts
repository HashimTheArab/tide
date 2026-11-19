import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";

import { createApp } from "./core/app.ts";

/** Starts the app on Node; port 0 picks a free port. */
export function startServer(port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: createApp().fetch, port }, () => resolve(server));
  });
}

if (import.meta.main) await startServer(Number(process.env.PORT ?? 8787));
