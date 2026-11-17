/**
 * THIRD-PARTY-NOTICES.txt for an esbuild bundle: the name, version, license
 * and license texts of every npm package in it, read from the metafile. Used
 * by the CLI build and the skill build.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Metafile } from "esbuild";

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyrightnotice)([._-].*)?$/i;

interface Package {
  name: string;
  version: string;
  license: string;
  /** [file, text]: license and notice files, plus licenses of code the package vendors (unpdf: pdf.js). */
  texts: [string, string][];
}

function readPackage(dir: string): Package {
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license?: string | { type?: string };
  };
  const license = typeof json.license === "string" ? json.license : (json.license?.type ?? "UNKNOWN");
  const texts: [string, string][] = [];
  const add = (folder: string, prefix: string) => {
    for (const file of readdirSync(folder).sort()) {
      const path = join(folder, file);
      if (statSync(path).isFile() && (prefix || LICENSE_FILE.test(file))) texts.push([prefix + file, readFileSync(path, "utf8").trim()]);
    }
  };
  add(dir, "");
  for (const vendored of ["licenses", "dist/licenses"]) {
    if (existsSync(join(dir, vendored))) add(join(dir, vendored), `${vendored}/`);
  }
  return { name: json.name, version: json.version, license, texts };
}

/** Packages in the bundle, by name; inputs are resolved against `cwd` (esbuild's working directory). */
export function bundledPackages(metafile: Metafile, cwd = process.cwd()): Package[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");
    if (at === -1 || input.includes(":")) continue;
    const [scope, name] = input.slice(at + "node_modules/".length).split("/");
    dirs.add(resolve(cwd, input.slice(0, at), "node_modules", scope!.startsWith("@") ? `${scope}/${name}` : scope!));
  }
  return [...dirs].map(readPackage).sort((a, b) => a.name.localeCompare(b.name));
}

export function thirdPartyNotices(metafile: Metafile, bundle: string, cwd = process.cwd()): string {
  const packages = bundledPackages(metafile, cwd);
  const rule = "=".repeat(78);
  const summary = (p: Package) => {
    const license = p.license.startsWith("(") ? p.license : `(${p.license})`;
    const vendored = p.texts.filter(([file]) => file.includes("/")).map(([file]) => file.split("/").pop());
    return `- ${p.name} ${p.version} ${license}${vendored.length ? `, with vendored code under its own licenses: ${vendored.join(", ")}` : ""}`;
  };
  const out = [bundle, "bundles the open-source packages below; their license texts follow.", "", ...packages.map(summary)];
  for (const p of packages) {
    out.push("", rule, `${p.name} ${p.version}`, `License: ${p.license}`, rule);
    if (p.texts.length === 0) {
      // Some packages ship no license file (@ai-sdk/provider-utils); the license itself is standard.
      const length = (q: Package) => q.texts.reduce((sum, [, text]) => sum + text.length, 0);
      const same = packages.filter((q) => q.license === p.license && q.texts.length > 0).sort((a, b) => length(b) - length(a))[0];
      out.push("", `The package ships no license file. Its license is ${p.license}${same ? `; the full text is the one under ${same.name} in this file.` : "."}`);
    }
    for (const [file, text] of p.texts) out.push("", `--- ${file}`, "", text);
  }
  return `${out.join("\n")}\n`;
}
