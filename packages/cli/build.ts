/**
 * Bundles the CLI and MCP server into dist/logisticshub.mjs (no runtime
 * dependencies), with the nomenclature data and the bundled packages’ notices.
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { thirdPartyNotices } from "./notices.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const version = JSON.parse(readFileSync(here("package.json"), "utf8")).version as string;

rmSync(here("dist"), { recursive: true, force: true });
const { metafile } = await build({
  entryPoints: [here("src/main.ts")],
  outfile: here("dist/logisticshub.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  metafile: true,
  // Licenses go into THIRD-PARTY-NOTICES.txt, in full.
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(version) },
  banner: {
    // Some bundled CommonJS dependencies call require(); give ESM output one.
    js: `#!/usr/bin/env node\n// logisticshub ${version} · MIT · https://github.com/tsirbiladze/logisticshub · bundled packages and their licenses: THIRD-PARTY-NOTICES.txt\nimport { createRequire as __lhCreateRequire } from "node:module"; const require = __lhCreateRequire(import.meta.url);`,
  },
});
copyFileSync(here("../core/src/hs-nomenclature.json.gz"), here("dist/hs-nomenclature.json.gz"));
writeFileSync(here("dist/THIRD-PARTY-NOTICES.txt"), thirdPartyNotices(metafile, `logisticshub ${version} (dist/logisticshub.mjs)`));
console.log(`✓ logisticshub ${version} → dist/logisticshub.mjs, dist/hs-nomenclature.json.gz, dist/THIRD-PARTY-NOTICES.txt`);
