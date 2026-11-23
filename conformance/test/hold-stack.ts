// Starts a stack, prints its dir and URL as one JSON line, and holds it until a signal ends the process. The held
// body then returns and another stack follows, which must not start.
import { once } from "node:events";

import { withStack } from "../src/stack.ts";

await withStack(async (stack) => {
  process.stdout.write(`${JSON.stringify({ dir: stack.dir, url: stack.serverUrl })}\n`);
  await once(stack.spawn("/bin/sleep", ["600"], {}), "close");
});
await withStack(() => Promise.resolve());
