/**
 * "provider:model" → AI SDK model. Claude is the default; OpenAI and
 * OpenRouter (any model it serves) are one flag away.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export const DEFAULT_MODEL = "anthropic:claude-opus-5-5";

const KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

export type Provider = keyof typeof KEYS;

export class ModelConfigError extends Error {}

export function parseModelId(id: string): { provider: Provider; model: string } {
  const at = id.indexOf(":");
  const provider = at === -1 ? "anthropic" : id.slice(0, at).trim();
  const model = (at === -1 ? id : id.slice(at + 1)).trim();
  // Object.hasOwn: "constructor:x" must not pass as a provider.
  if (!Object.hasOwn(KEYS, provider) || !model) {
    throw new ModelConfigError(`Unknown model "${id}". Use provider:model with provider anthropic, openai or openrouter.`);
  }
  return { provider: provider as Provider, model };
}

export function resolveModel(id: string, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const { provider, model } = parseModelId(id);
  const apiKey = env[KEYS[provider]];
  if (!apiKey) {
    throw new ModelConfigError(
      `Set ${KEYS[provider]} to extract with ${provider}, or pass an extraction.json to check without a model.`,
    );
  }
  if (provider === "anthropic") return createAnthropic({ apiKey })(model);
  if (provider === "openai") return createOpenAI({ apiKey })(model);
  return createOpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1", name: "openrouter" }).chat(model);
}
