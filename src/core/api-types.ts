import type { DigConfig } from "./config.ts";
import type { CostSummary } from "./cost.ts";
import type { LibraryDigItem, Receipt, ReadFileResult, ToolHistoryRow } from "./library.ts";
import type { ActiveCall, DigEvent } from "./progress.ts";
import type { SearchResponse } from "./search.ts";
import type { AccountStatus, SetupSnapshot, SourceStatus } from "./setup.ts";
import type { LedgerJob, PendingApproval } from "./workflow.ts";

/**
 * Shared HTTP & SSE contract between Dig 2.0's Effect HttpApi backend (`src/service/`)
 * and the localhost React 19 SPA (`src/frontend/`).
 */

export interface SourceCatalogItem extends SourceStatus {
  readonly about: string;
  readonly providers: readonly { readonly name: string; readonly url?: string }[];
  readonly logo?: string;
  readonly env?: readonly string[];
  readonly envSettings?: readonly {
    readonly name: string;
    readonly label: string;
    readonly purpose: string;
  }[];
  readonly requires?: readonly string[];
  readonly tool: string;
  readonly slow: readonly string[];
  readonly history?: readonly ToolHistoryRow[];
}

export interface LibrarySnapshotResponse {
  readonly version: string;
  readonly host: "any" | "codex" | "claude-code" | "antigravity";
  readonly library: string;
  readonly configPath: string;
  readonly keysPath: string;
  readonly items: readonly LibraryDigItem[];
  readonly live: readonly Receipt[];
  readonly running: readonly LedgerJob[];
  readonly activeCalls: readonly ActiveCall[];
  readonly pendingApprovals?: readonly PendingApproval[];
  readonly sources: readonly SourceCatalogItem[];
  readonly groups: readonly {
    readonly id: string;
    readonly label: string;
    readonly sources: readonly string[];
  }[];
  readonly accounts: readonly AccountStatus[];
  readonly spend: DigConfig["spend"];
  readonly keepRaw: boolean;
  readonly searchSemantic: boolean;
  readonly cost: CostSummary;
}

export interface SettingsFieldSchema {
  readonly type: "boolean" | "string" | "number";
  readonly title: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
}

export interface SettingsResponse {
  readonly values: Record<string, unknown>;
  readonly config: DigConfig;
  readonly schema: {
    readonly type: "object";
    readonly properties: Record<string, SettingsFieldSchema>;
  };
  readonly layout: readonly {
    readonly title: string;
    readonly items: readonly { readonly kind: "property"; readonly property: string }[];
  }[];
}

export interface SettingsUpdateRequest {
  readonly set: Record<string, unknown>;
}

export interface SetupKeysSaveRequest {
  readonly values: Record<string, string>;
}

export interface SetupKeysSaveResponse {
  readonly saved: readonly string[];
  readonly snapshot: SetupSnapshot;
}

export interface SetupPresetRequest {
  readonly preset: string;
}

export interface SetupSourcesRequest {
  readonly enabled: readonly string[];
}

export interface LibrarySearchRequest {
  readonly query: string;
  readonly project?: string;
  readonly dig?: string;
  readonly source?: string;
  readonly mode?: "auto" | "hybrid" | "keyword" | "semantic";
  readonly limit?: number;
}

export interface LibraryReadRequest {
  readonly file: string;
  readonly offset?: number;
  readonly limit?: number;
}

export type LibraryReadResponse = ReadFileResult;
export type LibrarySearchResponse = SearchResponse;
export type SetupSnapshotResponse = SetupSnapshot;

/** Typed SSE payload streamed by `GET /api/events`. */
export type DigSseEvent =
  | { readonly type: "connected"; readonly version: string; readonly at: string }
  | { readonly type: "heartbeat"; readonly at: string }
  | { readonly type: "event"; readonly event: DigEvent }
  | {
      readonly type: "jobs_snapshot";
      readonly running: readonly LedgerJob[];
      readonly activeCalls: readonly ActiveCall[];
      readonly pendingApprovals?: readonly PendingApproval[];
      readonly at: string;
    };
