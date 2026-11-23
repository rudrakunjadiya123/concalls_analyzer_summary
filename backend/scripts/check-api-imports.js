import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Import the runtime modules without executing the administrative CLI or listening on a port.
const source = new URL("../src/", import.meta.url);
const modules = readdirSync(source, {
  recursive: true,
  withFileTypes: true,
}).filter(
  (entry) =>
    entry.isFile() &&
    entry.name.endsWith(".js") &&
    entry.name !== "database.js",
);
for (const { name, parentPath } of modules) {
  await import(pathToFileURL(path.join(parentPath, name)));
}
console.log(`Validated ${modules.length} API runtime imports.`);
