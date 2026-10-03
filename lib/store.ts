// Tiny storage seam used for rate limits, scan quotas, the enrichment cache and the price index.
//
// With UPSTASH_REDIS_REST_URL/TOKEN (or the Vercel KV equivalents KV_REST_API_URL/TOKEN) set it is
// shared across all serverless instances. Without them it falls back to per-instance memory, which
// keeps local dev working but means limits and the price index only live as long as the instance.

type Cmd = (string | number)[];

const URL_ = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

export const isPersistent = Boolean(URL_ && TOKEN);

async function remote(cmds: Cmd[]): Promise<unknown[]> {
  const res = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(3000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`store ${res.status}`);
  const out = (await res.json()) as { result?: unknown; error?: string }[];
  return out.map((r) => {
    if (r.error) throw new Error(r.error);
    return r.result ?? null;
  });
}

// ---- in-memory fallback ----
const mem = new Map<string, { v: string | string[]; exp: number }>();

function memGet(key: string) {
  const e = mem.get(key);
  if (!e) return undefined;
  if (e.exp && e.exp < Date.now()) {
    mem.delete(key);
    return undefined;
  }
  return e;
}

function memSet(key: string, v: string | string[], ttlSec?: number) {
  if (mem.size > 5000) mem.clear(); // crude bound; this path is dev / no-store only
  mem.set(key, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
}

/** Increment a counter; the TTL is applied when the key is first created. */
export async function incr(key: string, ttlSec?: number): Promise<number> {
  if (isPersistent) {
    try {
      const cmds: Cmd[] = [["INCR", key]];
      if (ttlSec) cmds.push(["EXPIRE", key, ttlSec, "NX"]);
      return Number((await remote(cmds))[0]) || 0;
    } catch (e) {
      console.error("store incr failed, using memory", e);
    }
  }
  const e = memGet(key);
  const n = (e ? Number(e.v) : 0) + 1;
  memSet(key, String(n), e ? Math.max(1, Math.round((e.exp - Date.now()) / 1000)) : ttlSec);
  return n;
}

export async function peek(key: string): Promise<number> {
  if (isPersistent) {
    try {
      return Number((await remote([["GET", key]]))[0]) || 0;
    } catch (e) {
      console.error("store peek failed, using memory", e);
    }
  }
  return Number(memGet(key)?.v ?? 0) || 0;
}

export async function getJsonMany<T>(keys: string[]): Promise<(T | null)[]> {
  if (!keys.length) return [];
  const parse = (raw: unknown): T | null => {
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  if (isPersistent) {
    try {
      const raw = (await remote([["MGET", ...keys]]))[0];
      return Array.isArray(raw) ? raw.map(parse) : keys.map(() => null);
    } catch (e) {
      console.error("store mget failed, using memory", e);
    }
  }
  return keys.map((k) => parse(memGet(k)?.v));
}

export async function setJsonMany(entries: [string, unknown][], ttlSec: number): Promise<void> {
  if (!entries.length) return;
  if (isPersistent) {
    try {
      await remote(entries.map(([k, v]) => ["SET", k, JSON.stringify(v), "EX", ttlSec] as Cmd));
      return;
    } catch (e) {
      console.error("store set failed, using memory", e);
    }
  }
  for (const [k, v] of entries) memSet(k, JSON.stringify(v), ttlSec);
}

/** Push onto the head of a list, keeping only the newest `cap` entries. */
export async function pushCapped(key: string, value: string, cap: number, ttlSec: number): Promise<void> {
  if (isPersistent) {
    try {
      await remote([["LPUSH", key, value], ["LTRIM", key, 0, cap - 1], ["EXPIRE", key, ttlSec]]);
      return;
    } catch (e) {
      console.error("store push failed, using memory", e);
    }
  }
  const e = memGet(key);
  const list = Array.isArray(e?.v) ? e.v : [];
  memSet(key, [value, ...list].slice(0, cap), ttlSec);
}

export async function pushCappedMany(items: { key: string; value: string }[], cap: number, ttlSec: number): Promise<void> {
  if (!items.length) return;
  if (isPersistent) {
    try {
      await remote(items.flatMap(({ key, value }) => [["LPUSH", key, value], ["LTRIM", key, 0, cap - 1], ["EXPIRE", key, ttlSec]] as Cmd[]));
      return;
    } catch (e) {
      console.error("store push failed, using memory", e);
    }
  }
  for (const { key, value } of items) await pushCapped(key, value, cap, ttlSec);
}

export async function rangeMany(keys: string[], n: number): Promise<string[][]> {
  if (!keys.length) return [];
  if (isPersistent) {
    try {
      const out = await remote(keys.map((k) => ["LRANGE", k, 0, n - 1] as Cmd));
      return out.map((r) => (Array.isArray(r) ? r.map(String) : []));
    } catch (e) {
      console.error("store range failed, using memory", e);
    }
  }
  return keys.map((k) => {
    const v = memGet(k)?.v;
    return Array.isArray(v) ? v.slice(0, n) : [];
  });
}
