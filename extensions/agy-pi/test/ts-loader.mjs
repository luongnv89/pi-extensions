// Runs via `node --import ./test/ts-loader.mjs --test`. Node < 22.6 cannot
// import the extension's TypeScript sources directly, so register a loader
// hook that transpiles files under src/ using the bundled typescript
// devDependency. No new runtime dependencies.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(new URL("./ts-transform.mjs", import.meta.url), pathToFileURL(import.meta.url).href);
