import { z } from "zod";

export const REGISTRY_SOURCE = "https://xdata.rs.ge/TaxPayer/RSPublicInfo";
export const REGISTRY_VERSION = "1";
export const COMPANY_CODE = /^[0-9]{9}$(?![\s\S])/;
export const REGISTRY_FIELDS = [
  "FullName", "Status", "RegisteredSubject", "StartDate", "VatPayer",
  "Mortgage", "Sequestration", "AdditionalStatus", "NonResident",
] as const;

const taxpayerRow = z.object({
  FullName: z.string(),
  Status: z.string(),
  RegisteredSubject: z.string(),
  StartDate: z.string(),
  VatPayer: z.string(),
  Mortgage: z.string(),
  Sequestration: z.string(),
  AdditionalStatus: z.string(),
  NonResident: z.string(),
});
export const taxpayerAnswer = z.array(taxpayerRow);
export const taxpayerError = z.object({
  Status: z.union([z.literal(-1), z.literal(-100), z.literal(-101)]),
  Message: z.string(),
});
const transportFailure = z.object({ transport: z.string().min(1) });
const entryFields = {
  code: z.string().regex(COMPANY_CODE),
  checkedAt: z.iso.datetime().refine((time) => /T[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(time) && !time.startsWith("0000-")),
};
const registrySchema = z.strictObject({
  schemaVersion: z.literal(REGISTRY_VERSION),
  sourceUrl: z.literal(REGISTRY_SOURCE),
  entries: z.array(z.union([
    z.strictObject({ ...entryFields, answer: taxpayerAnswer }),
    z.strictObject({ ...entryFields, error: z.union([taxpayerError.strict(), transportFailure.strict()]) }),
  ])),
});

export type RegistrySnapshot = z.infer<typeof registrySchema>;
export type RegistryEntry = RegistrySnapshot["entries"][number];

export function parseRegistry(input: unknown): RegistrySnapshot {
  const parsed = registrySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid registry snapshot. Expected registry schema version ${REGISTRY_VERSION}, its source URL and valid entries.`);
  }
  const codes = new Set(parsed.data.entries.map(({ code }) => code));
  if (codes.size !== parsed.data.entries.length) throw new Error("Invalid registry snapshot: duplicate company codes.");
  return parsed.data;
}
