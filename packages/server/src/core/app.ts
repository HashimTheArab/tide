import { Hono } from "hono";

/** Returns the Tide HTTP app; it uses only web-standard APIs, so every runtime serves the same app. */
export function createApp(): Hono {
  const app = new Hono();
  app.get("/hc", (c) => c.text("ok"));
  return app;
}
