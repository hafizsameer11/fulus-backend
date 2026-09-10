export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ProviderRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
};

function buildUrl(baseUrl: string, path: string, query?: ProviderRequestOptions["query"]) {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function providerFetch<T = unknown>(
  baseUrl: string,
  options: ProviderRequestOptions,
): Promise<{ status: number; data: T }> {
  const url = buildUrl(baseUrl, options.path, options.query);
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data: T;
  try {
    data = text ? (JSON.parse(text) as T) : (null as T);
  } catch {
    data = text as T;
  }

  return { status: response.status, data };
}
