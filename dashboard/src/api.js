// Vite replaces this at build time. The fallback keeps local development simple.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");

export function savedReadKey() {
  try { return sessionStorage.getItem("cold-storage-read-key") || ""; }
  catch { return ""; }
}

export function saveReadKey(key) {
  try {
    if (key) sessionStorage.setItem("cold-storage-read-key", key);
    else sessionStorage.removeItem("cold-storage-read-key");
  } catch { /* A private browsing policy may disable session storage. */ }
}

export function readHeaders(key) {
  return key ? { "X-Dashboard-Key": key } : {};
}
