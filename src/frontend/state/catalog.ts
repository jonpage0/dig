import { useMemo } from "react";
import type { LibrarySnapshotResponse, SourceCatalogItem } from "../../core/api-types.ts";
import type { ActiveCall } from "../../core/progress.ts";
import type { LedgerJob } from "../../core/workflow.ts";
import { createCatalog, type UiCatalog } from "../../ui/catalog.ts";
import type { LiveProgressState } from "./atoms.ts";

export function buildCatalog(sources: readonly SourceCatalogItem[] | undefined): UiCatalog {
  return createCatalog(
    (sources ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      methods: s.methods.map((name) => ({ name })),
    })),
  );
}

export function useDigCatalog(snapshot: LibrarySnapshotResponse | undefined): UiCatalog {
  return useMemo(() => buildCatalog(snapshot?.sources), [snapshot?.sources]);
}

export function useSourceLogoMap(
  snapshot: LibrarySnapshotResponse | undefined,
): ReadonlyMap<string, string | undefined> {
  return useMemo(
    () => new Map((snapshot?.sources ?? []).map((s) => [s.id, s.logo])),
    [snapshot?.sources],
  );
}

/**
 * Merges live SSE `jobs_snapshot`/`job_*` state with the initial `/api/library` snapshot
 * so active calls appear immediately on first load and update in real time via SSE.
 */
export function useActiveActivity(
  snapshot: LibrarySnapshotResponse | undefined,
  live: LiveProgressState,
): {
  readonly activeCalls: readonly ActiveCall[];
  readonly runningJobs: readonly LedgerJob[];
} {
  return useMemo(() => {
    if (live.hasSnapshot || live.activeCalls.size > 0) {
      return {
        activeCalls: [...live.activeCalls.values()].sort(
          (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
        ),
        runningJobs: live.running.length > 0 ? live.running : (snapshot?.running ?? []),
      };
    }
    return {
      activeCalls: snapshot?.activeCalls ?? [],
      runningJobs: snapshot?.running ?? [],
    };
  }, [snapshot?.activeCalls, snapshot?.running, live]);
}
