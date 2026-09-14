"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

interface MerchantInfo {
  merchantId: string;
  name: string;
  email: string | null;
  razorpayConnected: boolean;
}

interface SessionState {
  status: "loading" | "ready" | "unauthenticated" | "error";
  merchant?: MerchantInfo;
  error?: string;
}

interface SessionContextValue extends SessionState {
  retry: () => void;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue>({
  status: "loading",
  retry: () => {},
  login: async () => {},
  signup: async () => {},
  logout: async () => {},
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const fetchSession = useCallback(() => {
    api
      .get<{ merchantId: string; name: string; email: string | null; razorpayConnected: boolean }>("/api/session/me")
      .then((res) =>
        setState({
          status: "ready",
          merchant: { merchantId: res.merchantId, name: res.name, email: res.email, razorpayConnected: res.razorpayConnected },
        }),
      )
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          // Expected, common state — no session cookie yet (or it expired) — not a backend
          // failure, so it doesn't get the "backend unavailable, retry" treatment below.
          setState({ status: "unauthenticated" });
          return;
        }
        setState({
          status: "error",
          error: err instanceof ApiError ? err.message : "Could not reach the RazorRecover backend. Is it running?",
        });
      });
  }, []);

  // Initial check on mount — state already starts as "loading", so nothing needs to be set
  // synchronously here; the effect just kicks off the request.
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Manual retry (button click, not an effect) — resetting to "loading" synchronously here is fine.
  const retry = useCallback(() => {
    setState({ status: "loading" });
    fetchSession();
  }, [fetchSession]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ merchantId: string; name: string; email: string }>("/api/auth/login", {
      email,
      password,
    });
    setState({
      status: "ready",
      merchant: { merchantId: res.merchantId, name: res.name, email: res.email, razorpayConnected: false },
    });
    // razorpayConnected wasn't part of the login response — /me is the single source of truth for
    // it and is cheap enough to just re-fetch right after, rather than duplicating that field onto
    // every auth response.
    fetchSession();
  }, [fetchSession]);

  const signup = useCallback(async (name: string, email: string, password: string) => {
    const res = await api.post<{ merchantId: string; name: string; email: string }>("/api/auth/signup", {
      name,
      email,
      password,
    });
    setState({
      status: "ready",
      merchant: { merchantId: res.merchantId, name: res.name, email: res.email, razorpayConnected: false },
    });
  }, []);

  const logout = useCallback(async () => {
    await api.post("/api/auth/logout");
    setState({ status: "unauthenticated" });
  }, []);

  return (
    <SessionContext.Provider value={{ ...state, retry, login, signup, logout }}>{children}</SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}
