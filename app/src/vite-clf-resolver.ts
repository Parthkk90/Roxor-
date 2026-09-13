import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Lets the frontend import the project's real CLF compiler out of `../src/`.
 *
 * That directory is authored for Node's ESM resolution, so its relative imports carry a `.js`
 * suffix that does not exist on disk (`../../types/index.js` -> `../../types/index.ts`). Vite's
 * bundler resolution does not perform that rewrite, so without this the app would have to keep its
 * own copy of the rule-program encoder - and a second encoder is exactly the kind of drift the
 * compiler's Solidity differential test exists to prevent.
 *
 * Scoped deliberately narrowly: only relative specifiers ending in `.js` whose `.ts` sibling
 * exists are rewritten. Anything else falls through to Vite untouched.
 */
export function clfResolver(): Plugin {
  return {
    name: "clf-js-to-ts",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
      const candidate = `${resolve(dirname(importer), source).slice(0, -3)}.ts`;
      return existsSync(candidate) ? candidate : null;
    },
  };
}
