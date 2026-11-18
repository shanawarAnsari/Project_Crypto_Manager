export function safeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    s.setItem("__qp", "1");
    s.removeItem("__qp");
    return s;
  } catch {
    return null;
  }
}
