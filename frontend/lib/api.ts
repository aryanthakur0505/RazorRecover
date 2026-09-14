const API_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_URL && typeof window !== "undefined") {
  // Fail loudly in the browser console rather than silently hitting a relative path.
  console.error("NEXT_PUBLIC_API_URL is not set — API calls will fail.");
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      // Required by the backend's CSRF check (see middleware/session.ts) on every non-GET
      // request — a cross-site <form> forgery can't set this, and a cross-site script trying to
      // would trigger a CORS preflight that the backend's single-origin CORS policy rejects.
      "X-Requested-With": "XMLHttpRequest",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
};

// SWR-compatible fetcher: swr calls fetcher(key) where key is the path.
export const fetcher = <T,>(path: string) => api.get<T>(path);

/** Downloads a file-returning endpoint (CSV export, etc.) as an actual browser download — can't
 *  reuse `request` above since that always parses the response as JSON. Reads the filename the
 *  server chose from Content-Disposition rather than hard-coding one client-side, so the two never
 *  drift out of sync. */
export async function downloadFile(path: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { credentials: "include" });
  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiError(res.status, message);
  }

  const disposition = res.headers.get("Content-Disposition");
  const filename = disposition?.match(/filename="?([^"]+)"?/)?.[1] ?? fallbackFilename;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
