// Starts a stack, prints its dir and URLs as one JSON line, and holds it until a signal ends the process.
import { withStack } from "../src/stack.ts";

await withStack(async (stack) => {
  process.stdout.write(
    `${JSON.stringify({ dir: stack.dir, urls: [stack.serverUrl, stack.assetUrl] })}\n`,
  );
  await new Promise(() => undefined);
});
