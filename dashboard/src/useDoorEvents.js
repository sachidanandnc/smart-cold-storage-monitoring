import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";
import { extractDoorEvents } from "./analytics";

export default function useDoorEvents() {
  const [state, setState] = useState({ data: null, error: "", pending: true, lastUpdated: null });
  const retryRef = useRef(() => {});
  useEffect(() => {
    let disposed = false;
    let busy = false;
    let controller;
    let timeout;
    async function load() {
      if (disposed || busy) return;
      busy = true;
      controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 10000);
      setState(previous => ({ ...previous, pending: true }));
      try {
        const response = await fetch(API_BASE + "/api/door-events", {
          signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const payload = await response.json();
        if (payload?.success === false) throw new Error("Door events unavailable");
        const data = extractDoorEvents(payload);
        if (!disposed) setState({ data, error: "", pending: false, lastUpdated: Date.now() });
      } catch {
        if (!disposed) setState(previous => ({ ...previous, error: "Door activity could not be refreshed.", pending: false }));
      } finally {
        clearTimeout(timeout);
        busy = false;
      }
    }
    retryRef.current = load;
    load();
    const interval = setInterval(load, 5000);
    return () => {
      disposed = true;
      clearInterval(interval);
      clearTimeout(timeout);
      controller?.abort();
    };
  }, []);
  const retry = useCallback(() => retryRef.current(), []);
  return { ...state, retry };
}
