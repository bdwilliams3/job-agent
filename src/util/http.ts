// HTTP with a browser-ish user agent, timeouts, and bounded retries.

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_RETRIES = 3;
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Performs one request, retrying transient failures with linear backoff.
 * Retries only on transport errors and RETRY_STATUS; 4xx surfaces immediately
 * because a bad URL will not fix itself.
 */
async function request(
  url: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
  options: HttpOptions | undefined,
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json, text/html;q=0.9,*/*;q=0.8",
    // Node's fetch decodes gzip and deflate but not zstd, and some ATS hosts
    // (Amazon Jobs) answer zstd when it is the first supported encoding offered.
    "accept-encoding": "gzip, deflate",
    ...init.headers,
    ...options?.headers,
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: init.method,
        body: init.body,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!RETRY_STATUS.has(response.status) || attempt === retries) return response;
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      if (attempt === retries) throw error;
      lastError = error;
    }
    await sleep(400 * (attempt + 1));
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

export async function getText(url: string, options?: HttpOptions): Promise<string> {
  const response = await request(url, { method: "GET" }, options);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.text();
}

export async function getJson<T>(url: string, options?: HttpOptions): Promise<T> {
  const body = await getText(url, options);
  return JSON.parse(body) as T;
}

export async function postJson<T>(
  url: string,
  body: unknown,
  options?: HttpOptions,
): Promise<T> {
  const response = await request(
    url,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...options?.headers },
    },
    options,
  );
  if (!response.ok) throw new Error(`POST ${url} -> ${response.status}`);
  return (await response.json()) as T;
}
