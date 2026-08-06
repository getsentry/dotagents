#!/usr/bin/env node
import { main } from "./main.js";

export { version } from "./main.js";

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
