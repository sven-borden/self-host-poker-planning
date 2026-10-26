// Run first by `pnpm gate` and `pnpm dev`: exits with one clear line on the wrong Node.
import { nodeVersionError } from "./node-version.mjs";

const error = nodeVersionError(process.version);
if (error) {
  console.error(error);
  process.exit(1);
}
