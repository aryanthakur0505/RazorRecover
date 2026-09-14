"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

interface SessionState {
  status: "loading" | "ready" | "error";
  merchantName?: string;
  error?: string;
}

const SessionContext = createContext<SessionState & { retry: () => void }>({
  status: "loading",
  retry: () => {},
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const fetchSession = useCallback(() => {
    api
      .post<{ merchantId: string; name: string }>("/api/session/init")
      .then((res) => setState({ status: "ready", merchantName: res.name }))
      .catch((err) =>
        setState({
          status: "error",
          error:
            err instanceof ApiError
              ? err.message
              : "Could not reach the RazorRecover backend. Is it running?",
        }),
      );
  }, []);

  // Initial fetch on mount — state already starts as "loading", so nothing needs to be set
  // synchronously here; the effect just kicks off the request.
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Manual retry (button click, not an effect) — resetting to "loading" synchronously here is fine.
  const retry = useCallback(() => {
    setState({ status: "loading" });
    fetchSession();
  }, [fetchSession]);

  return <SessionContext.Provider value={{ ...state, retry }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
