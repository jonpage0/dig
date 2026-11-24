import { useContext, useEffect } from "react";
import { Cause, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryContext } from "@effect/atom-react";
import type {
  DigSseEvent,
  LibrarySnapshotResponse,
  SettingsResponse,
  SetupSnapshotResponse,
} from "../../core/api-types.ts";
import type { ActiveCall, DigEvent } from "../../core/progress.ts";
import type { LedgerJob, PendingApproval } from "../../core/workflow.ts";
import { fetchLibrary, fetchSettings, fetchSetup } from "../api/client.ts";

export type SseStatus = "connecting" | "open" | "reconnecting" | "unauthorized";

export interface LiveTrailEvent {
  readonly id: string;
  readonly at: string;
  readonly kind:
    | "job_started"
    | "job_progress"
    | "job_finished"
    | "library_changed"
    | "settings_changed"
    | "approval_requested";
  readonly callId?: string;
  readonly source?: string;
  readonly tool?: string;
  readonly dig?: string;
  readonly message?: string;
  readonly status?: string;
  readonly progress?: number;
  readonly total?: number;
  readonly code?: string;
}

export interface LiveProgressState {
  readonly activeCalls: ReadonlyMap<string, ActiveCall>;
  readonly running: readonly LedgerJob[];
  readonly pendingApprovals: readonly PendingApproval[];
  readonly events: readonly LiveTrailEvent[];
  readonly hasSnapshot: boolean;
  readonly lastEventAt: string | null;
}

const INITIAL_LIVE_PROGRESS: LiveProgressState = {
  activeCalls: new Map<string, ActiveCall>(),
  running: [],
  pendingApprovals: [],
  events: [],
  hasSnapshot: false,
  lastEventAt: null,
};

const MAX_TRAIL_EVENTS = 150;

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const libraryAtom = Atom.make(
  Effect.tryPromise({
    try: () => fetchLibrary(),
    catch: toError,
  }),
).pipe(Atom.keepAlive);

export const settingsAtom = Atom.make(
  Effect.tryPromise({
    try: () => fetchSettings(),
    catch: toError,
  }),
).pipe(Atom.keepAlive);

export const setupAtom = Atom.make(
  Effect.tryPromise({
    try: () => fetchSetup(),
    catch: toError,
  }),
).pipe(Atom.keepAlive);

export const sseStatusAtom = Atom.make<SseStatus>("connecting").pipe(Atom.keepAlive);

export const liveProgressAtom = Atom.make<LiveProgressState>(INITIAL_LIVE_PROGRESS).pipe(
  Atom.keepAlive,
);

export const usageWindowDaysAtom = Atom.make<number>(30).pipe(Atom.keepAlive);

export function resultData<A, E>(result: AsyncResult.AsyncResult<A, E>): A | undefined {
  return Option.getOrUndefined(AsyncResult.value(result));
}

export function resultLoading<A, E>(result: AsyncResult.AsyncResult<A, E>): boolean {
  return AsyncResult.isInitial(result) || AsyncResult.isWaiting(result);
}

export function resultError<A, E>(result: AsyncResult.AsyncResult<A, E>): string | null {
  if (!AsyncResult.isFailure(result)) return null;
  const typed = Option.getOrUndefined(AsyncResult.error(result));
  if (typed instanceof Error) return typed.message;
  if (typeof typed === "string") return typed;
  return Cause.pretty(result.cause);
}

/** Extract `[projectSegment, digSegment]` for `/dig/$project/$dig` URLs. */
export function digRouteParams(
  digHandle: string,
  fallbackProject?: string,
  fallbackId?: string,
): { readonly project: string; readonly dig: string } {
  const slash = digHandle.indexOf("/");
  if (slash > 0 && slash < digHandle.length - 1) {
    return {
      project: digHandle.slice(0, slash),
      dig: digHandle.slice(slash + 1),
    };
  }
  return {
    project: fallbackProject ? encodeURIComponent(fallbackProject) : "project",
    dig: fallbackId || digHandle,
  };
}

/** Extract `[projectSegment, digSegment]` from a relative library file path `<projectFolder>/digs/<digId>/<file>`. */
export function digRouteFromFile(
  file: string,
): { readonly project: string; readonly dig: string } | null {
  const parts = file.split("/").filter(Boolean);
  if (parts.length >= 4 && parts[1] === "digs") {
    return { project: parts[0], dig: parts[2] };
  }
  if (parts.length >= 3) {
    return { project: parts[0], dig: parts[1] };
  }
  return null;
}

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `evt-${Date.now()}-${eventCounter}`;
}

function appendEvent(
  events: readonly LiveTrailEvent[],
  entry: LiveTrailEvent,
): readonly LiveTrailEvent[] {
  return [entry, ...events].slice(0, MAX_TRAIL_EVENTS);
}

function applyDigEvent(prev: LiveProgressState, event: DigEvent): LiveProgressState {
  const nowIso = new Date().toISOString();

  switch (event.type) {
    case "job_started": {
      const nextMap = new Map(prev.activeCalls);
      nextMap.set(event.call.callId, event.call);
      return {
        ...prev,
        activeCalls: nextMap,
        lastEventAt: event.call.startedAt || nowIso,
        events: appendEvent(prev.events, {
          id: nextEventId(),
          at: event.call.startedAt || nowIso,
          kind: "job_started",
          callId: event.call.callId,
          source: event.call.source,
          tool: event.call.tool,
          dig: event.call.dig,
          message: event.call.progress?.message ?? "Started provider call",
        }),
      };
    }

    case "job_progress": {
      const nextMap = new Map(prev.activeCalls);
      const existing = nextMap.get(event.callId);
      if (existing) {
        nextMap.set(event.callId, { ...existing, progress: event.progress });
      }
      return {
        ...prev,
        activeCalls: nextMap,
        lastEventAt: event.progress.at || nowIso,
        events: appendEvent(prev.events, {
          id: nextEventId(),
          at: event.progress.at || nowIso,
          kind: "job_progress",
          callId: event.callId,
          source: existing?.source,
          tool: existing?.tool,
          dig: existing?.dig,
          message: event.progress.message,
          progress: event.progress.progress,
          total: event.progress.total,
        }),
      };
    }

    case "job_finished": {
      const nextMap = new Map(prev.activeCalls);
      const existing = nextMap.get(event.callId);
      nextMap.delete(event.callId);
      return {
        ...prev,
        activeCalls: nextMap,
        running: prev.running.filter((job) => job.id !== event.callId),
        lastEventAt: nowIso,
        events: appendEvent(prev.events, {
          id: nextEventId(),
          at: nowIso,
          kind: "job_finished",
          callId: event.callId,
          source: existing?.source,
          tool: existing?.tool,
          dig: existing?.dig,
          status: event.status,
          message: `Finished (${event.status})`,
        }),
      };
    }

    case "library_changed": {
      return {
        ...prev,
        lastEventAt: event.at || nowIso,
        events: appendEvent(prev.events, {
          id: nextEventId(),
          at: event.at || nowIso,
          kind: "library_changed",
          dig: event.dig,
          message: event.dig ? `Saved research updated (${event.dig})` : "Research library updated",
        }),
      };
    }

    case "settings_changed": {
      return {
        ...prev,
        lastEventAt: event.at || nowIso,
        events: appendEvent(prev.events, {
          id: nextEventId(),
          at: event.at || nowIso,
          kind: "settings_changed",
          message: "Settings or credentials updated",
        }),
      };
    }

    case "approval_requested": {
      return {
        ...prev,
        lastEventAt: nowIso,
        events: appendEvent(prev.events, {
          id: nextEventId(),
          at: nowIso,
          kind: "approval_requested",
          dig: event.dig,
          tool: event.tool,
          code: event.code,
          message: `Spend approval requested for ${event.tool}`,
        }),
      };
    }
  }
}

/**
 * Connects once at the root of the SPA to `GET /api/events` (SSE).
 * Drives live progress state and triggers `Registry.refresh` on server change events.
 * Zero interval polling.
 */
export function useDigSse(): void {
  const registry = useContext(RegistryContext);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return;
    }

    registry.set(sseStatusAtom, "connecting");
    const source = new EventSource("/api/events");

    let libraryTimer: number | null = null;
    let settingsTimer: number | null = null;

    const scheduleLibraryRefresh = () => {
      if (libraryTimer !== null) return;
      libraryTimer = window.setTimeout(() => {
        libraryTimer = null;
        registry.refresh(libraryAtom);
      }, 120);
    };

    const scheduleSettingsRefresh = () => {
      if (settingsTimer !== null) return;
      settingsTimer = window.setTimeout(() => {
        settingsTimer = null;
        registry.refresh(settingsAtom);
        registry.refresh(setupAtom);
        registry.refresh(libraryAtom);
      }, 120);
    };

    const handlePayload = (raw: string) => {
      let msg: DigSseEvent;
      try {
        msg = JSON.parse(raw) as DigSseEvent;
      } catch {
        return;
      }

      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "connected":
          registry.set(sseStatusAtom, "open");
          break;

        case "heartbeat":
          registry.set(sseStatusAtom, "open");
          break;

        case "jobs_snapshot": {
          const map = new Map<string, ActiveCall>();
          for (const call of msg.activeCalls ?? []) {
            map.set(call.callId, call);
          }
          registry.update(liveProgressAtom, (prev) => ({
            ...prev,
            activeCalls: map,
            running: msg.running ?? [],
            pendingApprovals: msg.pendingApprovals ?? prev.pendingApprovals,
            hasSnapshot: true,
            lastEventAt: msg.at,
          }));
          break;
        }

        case "event": {
          const ev = msg.event;
          if (!ev || typeof ev.type !== "string") break;
          registry.update(liveProgressAtom, (prev) => applyDigEvent(prev, ev));
          if (
            ev.type === "library_changed" ||
            ev.type === "job_started" ||
            ev.type === "job_finished" ||
            ev.type === "approval_requested"
          ) {
            scheduleLibraryRefresh();
          } else if (ev.type === "settings_changed") {
            scheduleSettingsRefresh();
          }
          break;
        }
      }
    };

    source.onopen = () => {
      registry.set(sseStatusAtom, "open");
    };

    source.onmessage = (event) => {
      if (typeof event.data === "string") {
        handlePayload(event.data);
      }
    };

    let closed = false;
    source.onerror = () => {
      if (closed) return;
      if (source.readyState === EventSource.CLOSED) {
        registry.set(sseStatusAtom, "unauthorized");
        return;
      }
      registry.set(sseStatusAtom, "reconnecting");
      void fetch("/api/library", { method: "GET", credentials: "same-origin" })
        .then((res) => {
          if (closed) return;
          if (res.status === 401 || res.status === 403) {
            closed = true;
            source.close();
            registry.set(sseStatusAtom, "unauthorized");
          }
        })
        .catch(() => {});
    };

    return () => {
      closed = true;
      if (libraryTimer !== null) window.clearTimeout(libraryTimer);
      if (settingsTimer !== null) window.clearTimeout(settingsTimer);
      source.close();
    };
  }, [registry]);
}

export type LibraryAsyncResult = AsyncResult.AsyncResult<LibrarySnapshotResponse, Error>;
export type SettingsAsyncResult = AsyncResult.AsyncResult<SettingsResponse, Error>;
export type SetupAsyncResult = AsyncResult.AsyncResult<SetupSnapshotResponse, Error>;
