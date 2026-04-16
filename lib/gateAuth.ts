import { createHash, createHmac } from "node:crypto";

/** Live trading REST base (same as public `api.gateio.ws`). */
export const GATE_REST_BASE = "https://api.gateio.ws";

export interface GateCredentials {
  key: string;
  secret: string;
}

/**
 * Read Gate API v4 key pair from env (optional).
 * Used for signed endpoints like `GET /api/v4/margin/uni/borrowable`.
 */
export function getGateCredentialsFromEnv(): GateCredentials | null {
  const key = process.env.GATE_API_KEY?.trim();
  const secret = process.env.GATE_API_SECRET?.trim();
  if (!key || !secret) return null;
  return { key, secret };
}

function sha512HexUtf8(data: string): string {
  return createHash("sha512").update(data, "utf8").digest("hex");
}

/**
 * Gate REST API v4 `apiv4` signature (matches `gateapi-python` `ApiClient.gen_sign`).
 *
 * sign = HMAC_SHA512(secret, METHOD + "\n" + url_path + "\n" + query_string + "\n" + sha512_hex(body) + "\n" + timestamp)
 */
export function gateSignV4(params: {
  method: string;
  /** Full path starting with `/api/v4`, e.g. `/api/v4/margin/uni/borrowable` */
  urlPath: string;
  /** Raw query string without leading `?` (empty if none) */
  queryString: string;
  /** Request body string; use `""` for GET */
  body: string;
  secret: string;
  /** Unix time in seconds (float allowed, as in Python `time.time()`) */
  timestampSec: number;
}): string {
  const method = params.method.toUpperCase();
  const hashedPayload = sha512HexUtf8(params.body);
  const s = `${method}\n${params.urlPath}\n${params.queryString}\n${hashedPayload}\n${params.timestampSec}`;
  return createHmac("sha512", params.secret).update(s, "utf8").digest("hex");
}

/** Build `a=1&b=2` from ordered pairs (stable for signing == URL). */
export function encodeQueryPairs(pairs: [string, string][]): string {
  if (pairs.length === 0) return "";
  return pairs
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    )
    .join("&");
}

/**
 * Signed fetch to `https://api.gateio.ws` + `urlPath` + optional `?query`.
 */
export async function gateFetchSigned(
  creds: GateCredentials,
  urlPath: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    /** Ordered query pairs (signing string must match request URL) */
    query?: [string, string][];
    body?: string;
    timeoutMs?: number;
  }
): Promise<Response> {
  const method = init.method ?? "GET";
  const queryString = encodeQueryPairs(init.query ?? []);
  const body = method === "GET" || method === "DELETE" ? "" : (init.body ?? "");
  const timestampSec = Date.now() / 1000;
  const sign = gateSignV4({
    method,
    urlPath,
    queryString,
    body,
    secret: creds.secret,
    timestampSec,
  });

  const url = `${GATE_REST_BASE}${urlPath}${queryString ? `?${queryString}` : ""}`;
  const timeoutMs = init.timeoutMs ?? 15_000;

  return fetch(url, {
    method,
    headers: {
      KEY: creds.key,
      SIGN: sign,
      Timestamp: String(timestampSec),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body || undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}
