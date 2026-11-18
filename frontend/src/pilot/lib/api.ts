import { useStore } from "../store/useStore";

/** JSON fetch with friendly errors: never surfaces stack traces to the UI. */
export async function api<T = Record<string, unknown>>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const opts: RequestInit = { ...rest, headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) } };
  if (json !== undefined) opts.body = JSON.stringify(json);
  try {
    const res = await fetch(path, opts);
    if (res.status === 429) throw new Error("Rate limited: please wait a moment and retry.");
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(data?.message ?? `Request failed (${res.status}).`);
    return data;
  } catch (err) {
    const message = err instanceof TypeError ? "Cannot reach the Crypto Manager backend. Is it running?" : (err as Error).message;
    useStore.getState().pushToast({ level: "error", title: "Request failed", message });
    throw new Error(message);
  }
}

export const post = <T = Record<string, unknown>>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });
export const put = <T = Record<string, unknown>>(path: string, json: unknown = {}) => api<T>(path, { method: "PUT", json });
