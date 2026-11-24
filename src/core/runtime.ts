import { Layer, ManagedRuntime, Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  catalogMetaFromPlugins,
  ConfigService,
  KeysService,
  loadKeysIntoEnv,
  makeConfigLayer,
  makeKeysLayer,
  stateDirectory,
} from "./config.ts";
import { dbPath, DigDbMeta, makeDigDbLayer } from "./db.ts";
import { FreeHttp, HttpLive, PaidHttp } from "./http.ts";
import { LibraryService, makeLibraryLayer } from "./library.ts";
import type { ProviderAccount, SourcePlugin } from "./plugin.ts";
import { ProgressHub } from "./progress.ts";
import { makeSearchLayer, SearchService } from "./search.ts";
import { makeSetupLayer, SetupService } from "./setup.ts";
import { ExecutionService, makeExecutionLayer, makeWorkflowEngineLayer } from "./workflow.ts";

export type DigServices =
  | ConfigService
  | KeysService
  | SqlClient.SqlClient
  | DigDbMeta
  | PaidHttp
  | FreeHttp
  | ProgressHub
  | LibraryService
  | SearchService
  | ExecutionService
  | SetupService;

export interface DigRuntimeOptions {
  readonly stateDir?: string;
  readonly plugins: readonly SourcePlugin[];
  readonly accounts: readonly ProviderAccount[];
  readonly httpLayer?: Layer.Layer<PaidHttp | FreeHttp>;
  readonly loadKeys?: boolean;
  /**
   * Run crash recovery (`recoverCrashedCalls`) during boot.
   * Defaults to `false` so short-lived CLI commands (`dig list|read|search|stats|setup`) and
   * duplicate `dig serve` attempts before port bind never clobber an active daemon's in-flight jobs.
   */
  readonly recoverOnBoot?: boolean;
}

/**
 * Compose the entire Dig 2.0 Effect 4.1.5 service layer graph:
 * - ConfigService + KeysService (`config.toml` + `keys.env` `0600`)
 * - DigDb (`node:sqlite` WAL + migrations `0001..0004`)
 * - PaidHttp (zero retry) + FreeHttp (hop-safe SSRF + bounded transient retry)
 * - ProgressHub (`SubscriptionRef` + `PubSub` for MCP progress & Web SSE)
 * - LibraryService (plain-file archive + auto-rebuilt SQLite index)
 * - SearchService (SQLite FTS5 BM25 + optional ONNX semantic vectors)
 * - WorkflowEngine (`WorkflowEngine.layerMemory`) + ExecutionService (crash-safe `paid_call_ledger`)
 * - SetupService (shared by `dig setup` TUI & Web `/setup` wizard)
 */
export function makeDigLayer(options: DigRuntimeOptions): Layer.Layer<DigServices, unknown> {
  const dir = options.stateDir ?? stateDirectory();
  const meta = catalogMetaFromPlugins(options.plugins);
  if (options.loadKeys !== false) {
    loadKeysIntoEnv(dir, meta);
  }

  const dbLayer = makeDigDbLayer(dbPath(dir));
  const configLayer = makeConfigLayer(dir, meta);
  const keysLayer = makeKeysLayer(dir, meta);
  const hubLayer = ProgressHub.Live;
  const httpLayer = options.httpLayer ?? HttpLive;

  const libraryLayer = makeLibraryLayer(options.plugins).pipe(
    Layer.provide(Layer.mergeAll(configLayer, dbLayer, hubLayer)),
  );
  const searchLayer = makeSearchLayer(options.plugins).pipe(
    Layer.provide(Layer.mergeAll(configLayer, dbLayer, libraryLayer)),
  );
  const workflowEngineLayer = makeWorkflowEngineLayer().pipe(Layer.provide(dbLayer));
  const executionLayer = makeExecutionLayer(options.plugins).pipe(
    Layer.provide(Layer.mergeAll(configLayer, libraryLayer, dbLayer, hubLayer, httpLayer, workflowEngineLayer)),
  );
  const setupLayer = makeSetupLayer(options.plugins, options.accounts).pipe(
    Layer.provide(Layer.mergeAll(configLayer, keysLayer, hubLayer)),
  );

  return Layer.mergeAll(
    configLayer,
    keysLayer,
    dbLayer,
    httpLayer,
    hubLayer,
    libraryLayer,
    searchLayer,
    executionLayer,
    setupLayer,
  );
}

export type DigManagedRuntime = ManagedRuntime.ManagedRuntime<DigServices, unknown>;

/**
 * Create and boot a live Dig 2.0 `ManagedRuntime`:
 * 1. Initializes `config.toml` if missing
 * 2. Recovers any mid-flight `paid_call_ledger` rows left from a prior daemon crash (never re-sending HTTP)
 * 3. Rebuilds the SQLite library index from disk if `dig.sqlite` was freshly created or wiped
 */
export async function bootDigRuntime(options: DigRuntimeOptions): Promise<DigManagedRuntime> {
  const layer = makeDigLayer(options);
  const rt = ManagedRuntime.make(layer);
  await rt.runPromise(
    Effect.gen(function* () {
      const cfg = yield* ConfigService;
      const exec = yield* ExecutionService;
      const lib = yield* LibraryService;
      yield* cfg.initialize();
      if (options.recoverOnBoot === true) {
        yield* exec.recoverCrashedCalls();
      }
      yield* lib.syncIndex();
    }),
  );
  return rt;
}
