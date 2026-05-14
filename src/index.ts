import * as core from "@actions/core";
import { main } from "./main.js";

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(msg);
});
