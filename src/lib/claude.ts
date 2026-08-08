import { sleep } from './pool';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface ClaudeRequest {
  model: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * A JSON Schema. When set, the model is constrained to return JSON matching
   * it, so the response needs no fence-stripping and cannot arrive as prose.
   */
  jsonSchema?: Record<string, unknown>;
  /** low | medium | high | xhigh | max. Only sent when provided. */
  effort?: string;
}

/**
 * Sampling parameters were removed from the 4.6-and-later generations and are
 * rejected with a 400. Older models still accept them, and temperature 0 is
 * worth having on the scorer, so the parameter is sent only where it is legal.
 */
export function supportsTemperature(model: string): boolean {
  return !/(?:opus-5|sonnet-5|fable-5|mythos-5|opus-4-[678]|sonnet-4-6)/.test(model);
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  error?: { type: string; message: string };
}

/**
 * One Messages API call, with backoff on the two failures worth retrying:
 * rate limits and transient 5xx. Anything else fails fast — a 401 will not
 * fix itself on the third attempt.
 */
export async function callClaude(
  apiKey: string,
  req: ClaudeRequest,
  attempts = 3,
): Promise<string> {
  // Assistant-turn prefill returns a 400 on every 4.6-and-later model, so the
  // JSON shape is pinned with structured outputs instead.
  const messages = [{ role: 'user' as const, content: req.prompt }];

  const outputConfig: Record<string, unknown> = {};
  if (req.jsonSchema) outputConfig.format = { type: 'json_schema', schema: req.jsonSchema };
  if (req.effort) outputConfig.effort = req.effort;

  let lastError = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 700,
          ...(req.temperature !== undefined && supportsTemperature(req.model)
            ? { temperature: req.temperature }
            : {}),
          ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
          ...(req.system ? { system: req.system } : {}),
          messages,
        }),
      });
    } catch (err) {
      lastError = `network: ${String(err)}`;
      if (attempt < attempts) await sleep(500 * attempt);
      continue;
    }

    if (response.ok) {
      const data = (await response.json()) as AnthropicResponse;
      return (data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
    }

    const body = await response.text();
    lastError = `HTTP ${response.status}: ${body.slice(0, 300)}`;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) break;

    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * attempt);
  }

  throw new Error(`Claude call failed after ${attempts} attempt(s) — ${lastError}`);
}

/**
 * Pull a JSON object out of model output.
 *
 * Models sometimes fence the JSON, sometimes add a sentence either side. Strip
 * fences first, then fall back to the outermost brace pair.
 */
export function extractJson<T>(raw: string): T | null {
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    // fall through
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}
