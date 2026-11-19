import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeText, ioProblem, parseJson } from "./input.ts";
import { documentParties, georgianParty, taxDigits } from "./parties.ts";
import { COMPANY_CODE, REGISTRY_SOURCE, REGISTRY_VERSION, parseRegistry, taxpayerAnswer, taxpayerError, type RegistryEntry, type RegistrySnapshot } from "./registry.ts";
import { parseExtraction } from "./validate.ts";

const USER_AGENT = "Logisticshub (https://tsirbiladze.com/skills/logisticshub)";
const MAX_CODES = 20;

export class RegistryInputError extends Error {}

export function readRegistry(path: string): RegistrySnapshot {
  try {
    const json = parseJson(decodeText(readFileSync(path)));
    if (!json.ok) throw new Error(json.problem);
    return parseRegistry(json.value);
  } catch (error) {
    throw new RegistryInputError(`Cannot read registry snapshot ${path}: ${ioProblem(error)}`);
  }
}

/** These codes are reserved for the bundled synthetic fixtures. */
const isDemoCode = (code: string) => code.startsWith("90000");

interface RegistryClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<unknown>;
}

export function createRegistryClient({
  endpoint = REGISTRY_SOURCE,
  timeoutMs = 15_000,
  now = () => new Date(),
  sleep: wait = sleep,
}: RegistryClientOptions = {}) {
  async function lookup(code: string): Promise<RegistryEntry> {
    if (code.length === 11 && /^[0-9]+$/.test(code)) throw new RegistryInputError("Skipped lookup: an 11-digit personal number is never sent.");
    if (!COMPANY_CODE.test(code)) throw new RegistryInputError("Give a 9-digit Georgian company code.");
    if (isDemoCode(code)) throw new RegistryInputError("Skipped lookup: codes beginning with 90000 are reserved for synthetic fixtures.");
    const checkedAt = now().toISOString();
    const failure = (transport: string): RegistryEntry => ({ code, checkedAt, error: { transport } });
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ IdentCode: code }),
        redirect: "error",
        signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return failure(`HTTP ${response.status}`);
      }
      const body = await response.text();
      const json = parseJson(body);
      if (!json.ok) return failure("Invalid JSON response");
      const answer = taxpayerAnswer.safeParse(json.value);
      if (answer.success) return { code, checkedAt, answer: answer.data };
      const error = taxpayerError.safeParse(json.value);
      if (error.success) return { code, checkedAt, error: error.data };
      return failure("Unexpected response shape");
    } catch {
      return failure(signal.aborted ? "Request timed out" : "Connection failed");
    }
  }

  async function fetchSnapshot(input: unknown, log: (line: string) => void): Promise<RegistrySnapshot> {
    const parsed = parseExtraction(input);
    if (!parsed.ok) throw new RegistryInputError(`Cannot fetch registry snapshot: ${parsed.issues[0]?.path}: ${parsed.issues[0]?.message}`);
    const codes = new Set<string>();
    for (const doc of parsed.extraction.documents) {
      for (const [, party] of documentParties(doc)) {
        if (!georgianParty(party)) continue;
        const code = taxDigits(party.taxId);
        if (code && (code.length === 9 || code.length === 11)) codes.add(code);
      }
    }
    const companies = [...codes].filter((code) => {
      if (code.length === 11) log("Skipped an 11-digit personal number.");
      else if (isDemoCode(code)) log(`Skipped synthetic company code ${code}.`);
      else return true;
      return false;
    });
    if (companies.length > MAX_CODES) log(`Skipped ${companies.length - MAX_CODES} company code(s): the limit is ${MAX_CODES} per run.`);
    const entries: RegistryEntry[] = [];
    for (const code of companies.slice(0, MAX_CODES)) {
      if (entries.length) await wait(1000);
      entries.push(await lookup(code));
    }
    return { schemaVersion: REGISTRY_VERSION, sourceUrl: REGISTRY_SOURCE, entries };
  }
  return { lookup, fetchSnapshot };
}

export const { lookup: lookupTaxpayer, fetchSnapshot: fetchRegistry } = createRegistryClient();

export function registryJson(value: RegistryEntry | RegistrySnapshot): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function taxpayerText(entry: RegistryEntry): string {
  if ("error" in entry) {
    const error = "Status" in entry.error ? `${entry.error.Status}: ${entry.error.Message}` : entry.error.transport;
    const unavailable = "Status" in entry.error && entry.error.Status === -1 ? "" : "Could not be checked.\n";
    return `${entry.code} · ${entry.checkedAt}\n${unavailable}${error}\n`;
  }
  return `${entry.code} · ${entry.checkedAt}\n${JSON.stringify(entry.answer, null, 2)}\n`;
}

export async function registryCommand(command: "taxpayer" | "registry", args: string[], log: (line: string) => void): Promise<string> {
  const [input, option, target] = args;
  if (command === "taxpayer") {
    if (!input || args.length > 2 || (option !== undefined && option !== "--json")) {
      throw new RegistryInputError("Usage: taxpayer <9-digit company code> [--json]");
    }
    const entry = await lookupTaxpayer(input);
    return option === "--json" ? registryJson(entry) : taxpayerText(entry);
  }
  if (!input || input.startsWith("-") || (args.length !== 1 && (args.length !== 3 || (option !== "-o" && option !== "--out") || !target))) {
    throw new RegistryInputError("Usage: registry <extraction.json> [-o registry.json]");
  }
  const file = resolve(input);
  const path = resolve(target ?? "registry.json");
  if (path === file) throw new RegistryInputError("The registry snapshot and extraction must use different paths.");
  let json;
  try {
    json = parseJson(decodeText(readFileSync(file)));
  } catch (error) {
    throw new RegistryInputError(`Cannot read ${file}: ${ioProblem(error)}.`);
  }
  if (!json.ok) throw new RegistryInputError(`Cannot read ${file}: ${json.problem}.`);
  const snapshot = await fetchRegistry(json.value, log);
  try {
    writeFileSync(path, registryJson(snapshot));
  } catch (error) {
    throw new RegistryInputError(`Cannot write ${path}: ${ioProblem(error)}.`);
  }
  return `Files:\n- ${path}\n`;
}
