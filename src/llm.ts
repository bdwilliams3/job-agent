// Model access for generation. Ranking never calls this; only tailoring does.
//
// Providers are chosen by environment so the tool works with whatever credential
// is present. DeepSeek and OpenAI share the chat-completions shape; Gemini has
// its own. Model IDs are taken from the live /models listing of each provider,
// never guessed.
import { postJson } from "./util/http.ts";

export type Provider = "deepseek" | "openai" | "gemini";

export interface LlmConfig {
  provider: Provider;
  model: string;
  apiKey: string;
}

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string | null } }>;
}

interface GeminiResponse {
  candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
}

const OPENAI_COMPATIBLE: Record<
  "deepseek" | "openai",
  { url: string; envKey: string; defaultModel: string }
> = {
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-5.4-mini",
  },
};

const GEMINI_DEFAULT_MODEL = "gemini-2.5-pro";

/**
 * Resolves the provider from JOB_AGENT_PROVIDER, else the first provider with a
 * key present. Throws with the exact env var to set when nothing is available.
 */
export function resolveLlmConfig(overrides: {
  provider?: string;
  model?: string;
}): LlmConfig {
  const requested = overrides.provider ?? process.env.JOB_AGENT_PROVIDER;
  const supported: Provider[] = ["deepseek", "openai", "gemini"];

  if (requested !== undefined && !supported.includes(requested as Provider)) {
    throw new Error(
      `unknown provider "${requested}"; expected one of ${supported.join(", ")}`,
    );
  }
  const provider: Provider | undefined =
    requested !== undefined
      ? (requested as Provider)
      : supported.find((entry) => keyFor(entry) !== undefined);

  if (!provider) {
    throw new Error(
      "no model credential found; set DEEPSEEK_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY",
    );
  }
  const apiKey = keyFor(provider);
  if (!apiKey) {
    throw new Error(`provider "${provider}" has no key in the environment`);
  }

  const model =
    overrides.model ??
    process.env.JOB_AGENT_MODEL ??
    (provider === "gemini" ? GEMINI_DEFAULT_MODEL : OPENAI_COMPATIBLE[provider].defaultModel);

  return { provider, model, apiKey };
}

function keyFor(provider: Provider): string | undefined {
  switch (provider) {
    case "deepseek":
      return process.env.DEEPSEEK_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "gemini":
      return process.env.GEMINI_API_KEY;
  }
}

/** Sends one prompt and returns the model's text. */
export async function complete(
  config: LlmConfig,
  prompt: string,
  system: string,
): Promise<string> {
  if (config.provider === "gemini") {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${config.model}:generateContent?key=${config.apiKey}`;
    const response = await postJson<GeminiResponse>(url, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    });
    const text = response.candidates[0]?.content.parts
      .map((part) => part.text ?? "")
      .join("");
    if (!text) throw new Error("gemini returned no text");
    return text;
  }

  const endpoint = OPENAI_COMPATIBLE[config.provider];
  const response = await postJson<ChatCompletionsResponse>(
    endpoint.url,
    {
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 4096,
    },
    { headers: { authorization: `Bearer ${config.apiKey}` }, timeoutMs: 180_000 },
  );
  const text = response.choices[0]?.message.content;
  if (!text) throw new Error(`${config.provider} returned no text`);
  return text;
}

/** Confirms a provider answers, used by the doctor command. */
export async function ping(config: LlmConfig): Promise<string> {
  const text = await complete(config, "Reply with exactly: OK", "You are a health check.");
  return text.trim().slice(0, 40);
}

