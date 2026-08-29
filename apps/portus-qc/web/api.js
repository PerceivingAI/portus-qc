export async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers
  });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : undefined;
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
    error.code = payload?.error?.code || "request_failed";
    error.reason = payload?.error?.reason;
    throw error;
  }
  return payload;
}
