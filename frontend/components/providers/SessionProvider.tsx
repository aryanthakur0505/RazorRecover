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

  const init = useCallback(() => {
    setState({ status: "loading" });
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

  useEffect(() => {
    init();
  }, [init]);

  return <SessionContext.Provider value={{ ...state, retry: init }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
