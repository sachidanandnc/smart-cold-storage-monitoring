// Vite replaces this at build time. The fallback keeps local development simple.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
