// Shared OpenRouter chat helper.
//
// Reasoning control differs per model: some can switch it off (`enabled:false`), some have it
// mandatory and only accept an effort level, and some accept neither. Rather than hard-coding a
// table that goes stale, try the cheapest-to-run setting first and step down on a 400/422. The rung
// that worked is remembered per model for the life of the instance, so only the first call pays.

export const OR_BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

type Rung = "off" | "low" | "default";
const RUNGS: Rung[] = ["off", "low", "default"];
const RUNG_PARAMS: Record<Rung, Record<string, unknown>> = {
  off: { reasoning: { enabled: false }, include_reasoning: false },
  low: { reasoning: { effort: "low" }, include_reasoning: false },
  default: {},
};
const memo = new Map<string, Rung>();

export class LlmHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`LLM ${status}: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

export async function openrouterChat(
  apiKey: string,
  body: Record<string, unknown> & { model: string },
  timeoutMs: number,
): Promise<{ data: { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: unknown }; rung: Rung }> {
  const deadline = Date.now() + timeoutMs;
  const start = RUNGS.indexOf(memo.get(body.model) ?? "off");
  let lastErr: LlmHttpError | null = null;

  for (const rung of RUNGS.slice(start)) {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://instant-paire.vercel.app",
        "X-Title": "Instant Paire",
      },
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      body: JSON.stringify({ ...body, ...RUNG_PARAMS[rung] }),
    });
    if (res.ok) {
      memo.set(body.model, rung);
      return { data: await res.json(), rung };
    }
    lastErr = new LlmHttpError(res.status, await res.text().catch(() => ""));
    if (res.status !== 400 && res.status !== 422) throw lastErr; // not a parameter problem
  }
  throw lastErr ?? new LlmHttpError(500, "no attempt made");
}
