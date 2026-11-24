import type {
  LibraryReadRequest,
  LibraryReadResponse,
  LibrarySearchRequest,
  LibrarySearchResponse,
  LibrarySnapshotResponse,
  SettingsResponse,
  SettingsUpdateRequest,
  SetupKeysSaveResponse,
  SetupSnapshotResponse,
} from "../../core/api-types.ts";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    ...init,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const text = await response.text();
      if (text.trim()) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
          if (typeof parsed.message === "string" && parsed.message.trim()) {
            message = parsed.message.trim();
          } else if (typeof parsed.error === "string" && parsed.error.trim()) {
            message = parsed.error.trim();
          } else {
            message = text.trim();
          }
        } catch {
          message = text.trim();
        }
      }
    } catch {
      // Keep default status message.
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

export function fetchLibrary(): Promise<LibrarySnapshotResponse> {
  return requestJson<LibrarySnapshotResponse>("/api/library", { method: "GET" });
}

export function readLibraryFile(req: LibraryReadRequest): Promise<LibraryReadResponse> {
  return requestJson<LibraryReadResponse>("/api/library/read", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function searchLibrary(req: LibrarySearchRequest): Promise<LibrarySearchResponse> {
  return requestJson<LibrarySearchResponse>("/api/library/search", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function fetchSettings(): Promise<SettingsResponse> {
  return requestJson<SettingsResponse>("/api/settings", { method: "GET" });
}

export function updateSettings(req: SettingsUpdateRequest): Promise<SettingsResponse> {
  return requestJson<SettingsResponse>("/api/settings", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function fetchSetup(): Promise<SetupSnapshotResponse> {
  return requestJson<SetupSnapshotResponse>("/api/setup", { method: "GET" });
}

export function applySetupPreset(preset: string): Promise<SetupSnapshotResponse> {
  return requestJson<SetupSnapshotResponse>("/api/setup/preset", {
    method: "POST",
    body: JSON.stringify({ preset }),
  });
}

export function saveSetupSources(enabled: readonly string[]): Promise<SetupSnapshotResponse> {
  return requestJson<SetupSnapshotResponse>("/api/setup/sources", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function saveSetupKeys(values: Record<string, string>): Promise<SetupKeysSaveResponse> {
  return requestJson<SetupKeysSaveResponse>("/api/setup/keys", {
    method: "POST",
    body: JSON.stringify({ values }),
  });
}
