import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  blankDocument, checkDocuments, createRegistryClient, parseRegistry, REGISTRY_SOURCE, REGISTRY_VERSION,
  renderReports, SCHEMA_VERSION, type RegistryEntry, type RegistrySnapshot,
} from "../src/index.ts";
import { c, kaPack } from "./support/ka-pack.ts";

const route = "/TaxPayer/RSPublicInfo";
const checkedAt = "2026-11-19T10:30:00.000Z";
const row = {
  FullName: "შპს „სატესტო ავეჯი“", Status: "სატესტო", RegisteredSubject: "სატესტო",
  StartDate: "11/19/2026 9:00:00 AM", VatPayer: "არა", Mortgage: "სატესტო",
  Sequestration: "", AdditionalStatus: "", NonResident: "არა",
};
const snapshot = (entries: RegistryEntry[]): RegistrySnapshot => ({ schemaVersion: REGISTRY_VERSION, sourceUrl: REGISTRY_SOURCE, entries });
const demoCode = "900000001";

async function stub(reply: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    reply(req, res, Buffer.concat(chunks).toString("utf8"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local stub address.");
  return {
    endpoint: `http://127.0.0.1:${address.port}${route}`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

describe("Revenue Service client with a loopback HTTP stub", () => {
  it("posts only the exact code and preserves the success array and each published error", async () => {
    const replies = [
      [row],
      { Status: -1, Message: "გადამხდელი არ არის რეგისტრირებული ESERVICES.RS.GE-ზე" },
      { Status: -100, Message: "System error" },
      { Status: -101, Message: "Wrong request" },
    ] as const;
    const requests: unknown[] = [];
    const server = await stub((req, res, body) => {
      const response = replies[requests.length];
      requests.push({
        method: req.method, path: req.url, body,
        contentType: req.headers["content-type"], accept: req.headers.accept, userAgent: req.headers["user-agent"],
        authorization: req.headers.authorization, cookie: req.headers.cookie,
      });
      res.end(JSON.stringify(response));
    });
    try {
      const client = createRegistryClient({ endpoint: server.endpoint, now: () => new Date(checkedAt) });
      const code = "910000001";
      for (const reply of replies) {
        expect(await client.lookup(code)).toEqual({ code, checkedAt, ...(Array.isArray(reply) ? { answer: reply } : { error: reply }) });
      }
      expect(requests).toEqual(Array(replies.length).fill({
        method: "POST", path: route, body: '{"IdentCode":"910000001"}', contentType: "application/json", accept: "application/json",
        userAgent: "Logisticshub (https://tsirbiladze.com/skills/logisticshub)", authorization: undefined, cookie: undefined,
      }));
    } finally {
      server.close();
    }
  });

  it("records malformed JSON, wrong shape, non-200 and timeout without retrying", async () => {
    const seen: string[] = [];
    const server = await stub((_req, res, body) => {
      const code = (JSON.parse(body) as { IdentCode: string }).IdentCode;
      seen.push(code);
      switch (code.at(-1)) {
        case "1": res.end("{broken"); break;
        case "2": res.end('[{"FullName":"Synthetic"}]'); break;
        case "3": res.writeHead(503).end(); break;
        case "4": res.writeHead(200).write("["); break; // timeout covers reading the body
      }
    });
    try {
      const client = createRegistryClient({ endpoint: server.endpoint, timeoutMs: 200 });
      const failures = ["Invalid JSON response", "Unexpected response shape", "HTTP 503", "Request timed out"];
      for (const [i, transport] of failures.entries()) {
        expect(await client.lookup(`91000000${i + 1}`)).toMatchObject({ error: { transport } });
      }
      expect(seen).toEqual(["910000001", "910000002", "910000003", "910000004"]);
    } finally {
      server.close();
    }
  });

  it("deduplicates, spaces requests using the injected clock, caps the batch and skips personal numbers", async () => {
    let elapsed = 0;
    const start = Date.parse(checkedAt);
    const calls: { code: string; elapsed: number }[] = [];
    const server = await stub((_req, res, body) => {
      calls.push({ code: JSON.parse(body).IdentCode, elapsed });
      res.end("[]");
    });
    try {
      const client = createRegistryClient({
        endpoint: server.endpoint, now: () => new Date(start + elapsed),
        sleep: async (ms) => { elapsed += ms; },
      });
      const invoice = (id: string, code: string, country = c("საქართველო")) => {
        const doc = blankDocument("commercial_invoice", id);
        doc.seller.country = country;
        doc.seller.taxId = c(code);
        return doc;
      };
      const codes = Array.from({ length: 22 }, (_, i) => String(910000001 + i));
      const documents = [
        invoice("personal", "91000000001"), invoice("fixture", demoCode),
        invoice("not-confirmed", "910009991", c("GE", "United States")),
        invoice("duplicate", "GE 910-000-001"), ...codes.map((code) => invoice(code, code)),
      ];
      const notes: string[] = [];
      const result = await client.fetchSnapshot({ schemaVersion: SCHEMA_VERSION, documents }, (line) => notes.push(line));
      expect(parseRegistry(result)).toEqual(result);
      expect(calls).toEqual(codes.slice(0, 20).map((code, i) => ({ code, elapsed: i * 1000 })));
      expect(result.entries.map(({ checkedAt }) => Date.parse(checkedAt) - start)).toEqual(calls.map(({ elapsed }) => elapsed));
      expect(notes).toEqual([
        "Skipped an 11-digit personal number.", `Skipped synthetic company code ${demoCode}.`,
        "Skipped 2 company code(s): the limit is 20 per run.",
      ]);
      await expect(client.lookup("91000000001")).rejects.toThrow("personal number");
      await expect(client.lookup(demoCode)).rejects.toThrow("synthetic fixtures");
      await expect(client.lookup("910000001\n")).rejects.toThrow("9-digit");
      expect(calls).toHaveLength(20);
    } finally {
      server.close();
    }
  });
});

describe("offline tax checks", () => {
  it("distinguishes suspect text from conflicting cited digits, even without an invoice number to compare", () => {
    const pack = kaPack();
    const [invoice, list, cmr] = pack.documents;
    if (invoice?.type !== "commercial_invoice" || list?.type !== "packing_list" || cmr?.type !== "cmr") throw new Error("Invalid test fixture.");
    invoice.buyer.taxId = c(null);
    list.consignee.taxId = c("GE 900–000-001");
    expect(checkDocuments(pack).findings).toEqual([]);
    cmr.consignee.taxId = c("90000001");
    expect(checkDocuments(pack).findings.map(({ key }) => key)).toEqual(["PTY-02.unreadable"]);
    cmr.consignee.taxId = c("900000009", "900000001");
    expect(checkDocuments(pack).findings.map(({ key }) => key)).toEqual(["PTY-02.unreadable"]);
    cmr.consignee.taxId = c("900000009");
    const findings = checkDocuments(pack).findings;
    expect(findings.map(({ key, evidence }) => [key, evidence.map(({ quote }) => quote)])).toEqual([
      ["PTY-02.number", ["GE 900–000-001", "900000009"]],
    ]);
    invoice.buyer.name = c("Northern Desk");
    invoice.buyer.taxId = c("900000001");
    list.consignee.name = c("Southern Lamp");
    list.consignee.taxId = c("900000009");
    cmr.consignee.name = c("Northern Desk Southern Lamp");
    cmr.consignee.taxId = c("900000001");
    expect(checkDocuments(pack).findings.filter(({ rule }) => rule === "PTY-02").map(({ evidence }) => evidence.map(({ quote }) => quote)))
      .toEqual([["900000009", "900000001"]]);
  });

  it.each([
    { Status: -100 as const, Message: "System error" },
    { Status: -101 as const, Message: "Wrong request" },
    { transport: "Request timed out" },
  ])("shows %j and missing codes as unchecked without a finding", (error) => {
    const result = checkDocuments(kaPack(), { registry: snapshot([{ code: demoCode, checkedAt, error }]) });
    expect(result.findings).toEqual([]);
    const { md, html, json } = renderReports(result, "en");
    expect(md).toContain("Could not be checked");
    expect(html).toContain("Could not be checked");
    expect(JSON.parse(json).registry.entries).toEqual([
      { code: demoCode, parties: ["ტესტ კომპანია"], checkedAt, error, checked: false },
      { code: "900000002", parties: ["Caucasus Demo Transit LLC"], checkedAt: null, checked: false },
    ]);
  });

  it("does not compare names in different scripts or derive findings from undocumented fields", () => {
    const result = checkDocuments(kaPack(), { registry: snapshot([
      { code: demoCode, checkedAt, answer: [{ ...row, FullName: "Synthetic Buyer LLC" }] },
    ]) });
    expect(result.findings).toEqual([]);
    expect(renderReports(result).md).toContain(row.Mortgage);
  });

  it("refuses conflicting entries and malformed timestamps, codes, fields and replies", () => {
    const entry = { code: demoCode, checkedAt, answer: [row] };
    expect(() => parseRegistry(snapshot([entry, entry]))).toThrow("duplicate company codes");
    for (const invalid of [
      { ...entry, checkedAt: "2026-02-30T10:30:00Z" }, { ...entry, checkedAt: "2026-11-19T10:30:00+04:00" },
      { ...entry, code: "91000000001" }, { ...entry, answer: [{ ...row, VatPayer: false }] },
      { ...entry, error: { Status: -100, Message: "System error" } },
      { code: demoCode, checkedAt, error: { Status: -99, Message: "Unknown" } },
    ]) {
      expect(() => parseRegistry({ ...snapshot([]), entries: [invalid] })).toThrow("Invalid registry snapshot");
    }
  });
});
