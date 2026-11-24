import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Effect, Layer } from "effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Operational + rebuildable-index SQLite database (`<state>/dig.sqlite`) backed by
 * `@effect/sql-sqlite-node` on Node's built-in `node:sqlite` (zero native C++ addons,
 * WAL mode, `busy_timeout = 5000`, `BEGIN IMMEDIATE` writable transactions).
 *
 * Deleting `dig.sqlite` when Dig is stopped never loses permanent research: reports,
 * answers, receipts (`calls.jsonl`), raw payloads (`raw/*.json`), `config.toml`, and
 * `keys.env` remain plain files on disk and are automatically re-indexed on startup.
 */

export const dbPath = (stateDir: string): string => join(stateDir, "dig.sqlite");

const runMigrations = Migrator.make({})({
  table: "dig_migrations",
  loader: Migrator.fromRecord({
    "0001_operational_state": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE IF NOT EXISTS paid_call_ledger (
          call_id TEXT PRIMARY KEY,
          workflow_execution_id TEXT,
          dig_handle TEXT NOT NULL,
          project TEXT NOT NULL,
          source TEXT NOT NULL,
          tool TEXT NOT NULL,
          args_hash TEXT NOT NULL,
          args_redacted_json TEXT NOT NULL,
          declared_json TEXT NOT NULL,
          is_paid INTEGER NOT NULL DEFAULT 1,
          is_slow INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK (status IN ('pending_approval', 'dispatched', 'completed', 'failed', 'cancelled')),
          remote_job_id TEXT,
          receipt_id TEXT,
          cost_json TEXT,
          known_cost_json TEXT,
          outcome_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          dispatched_at TEXT,
          last_updated_at TEXT NOT NULL,
          finished_at TEXT
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_paid_call_lookup
        ON paid_call_ledger (dig_handle, tool, args_hash, created_at DESC)
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_paid_call_status
        ON paid_call_ledger (status, finished_at)
      `;
      yield* sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_paid_call_active_unique
        ON paid_call_ledger (dig_handle, tool, args_hash)
        WHERE status IN ('pending_approval', 'dispatched')
      `;

      yield* sql`
        CREATE TABLE IF NOT EXISTS deferred_tokens (
          code TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('keys', 'spend_approval', 'browser_open')),
          deferred_token TEXT,
          payload_json TEXT NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          result_json TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_deferred_expires ON deferred_tokens (expires_at)
      `;

      yield* sql`
        CREATE TABLE IF NOT EXISTS dig_spend_overrides (
          dig_handle TEXT PRIMARY KEY,
          raised_usd REAL NOT NULL DEFAULT 0,
          raised_credits REAL NOT NULL DEFAULT 0,
          raised_x_post_reads INTEGER NOT NULL DEFAULT 0,
          raised_x_account_reads INTEGER NOT NULL DEFAULT 0,
          raised_unknown_calls INTEGER NOT NULL DEFAULT 0,
          dont_ask INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        )
      `;

      yield* sql`
        CREATE TABLE IF NOT EXISTS browser_sessions (
          session_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )
      `;
    }),

    "0002_library_index": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE IF NOT EXISTS library_digs (
          dig_handle TEXT PRIMARY KEY,
          project_folder TEXT NOT NULL,
          dig_id TEXT NOT NULL,
          project TEXT NOT NULL,
          title TEXT NOT NULL,
          display_title TEXT NOT NULL,
          snippet TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          session_id TEXT,
          started_at TEXT,
          finished_at TEXT,
          answer_file TEXT,
          planned_json TEXT NOT NULL,
          refreshes TEXT,
          sources_json TEXT NOT NULL,
          methods_json TEXT NOT NULL,
          files_json TEXT NOT NULL,
          reports_json TEXT NOT NULL,
          mtime_ms REAL NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_library_digs_project ON library_digs (project, started_at DESC)
      `;

      yield* sql`
        CREATE TABLE IF NOT EXISTS library_reports (
          file TEXT PRIMARY KEY,
          dig_handle TEXT NOT NULL,
          project TEXT NOT NULL,
          dig_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('report', 'answer')),
          source TEXT,
          method TEXT,
          title TEXT NOT NULL,
          topic TEXT,
          summary TEXT NOT NULL,
          supersedes TEXT,
          superseded INTEGER NOT NULL DEFAULT 0,
          run_status TEXT,
          at TEXT,
          sha256 TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          size_bytes INTEGER NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_library_reports_dig ON library_reports (dig_handle, at)
      `;

      yield* sql`
        CREATE TABLE IF NOT EXISTS library_calls (
          receipt_id TEXT PRIMARY KEY,
          project_folder TEXT NOT NULL,
          session_folder TEXT NOT NULL,
          dig_handle TEXT,
          dig_id TEXT,
          source TEXT NOT NULL,
          tool TEXT NOT NULL,
          status TEXT NOT NULL,
          at TEXT NOT NULL,
          ms INTEGER NOT NULL,
          cost_json TEXT,
          known_cost_json TEXT,
          raw_file TEXT,
          error TEXT,
          args_json TEXT NOT NULL,
          attempts INTEGER
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_library_calls_dig ON library_calls (dig_handle, at)
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_library_calls_history ON library_calls (tool, at DESC)
      `;

      yield* sql`
        CREATE TABLE IF NOT EXISTS library_indexed_files (
          path TEXT PRIMARY KEY,
          library_root TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL
        )
      `;
    }),

    "0003_search_fts5": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE IF NOT EXISTS search_passages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          library_root TEXT NOT NULL,
          file TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          start_offset INTEGER NOT NULL,
          end_offset INTEGER NOT NULL,
          heading TEXT,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          model_id TEXT,
          model_revision TEXT,
          vector BLOB
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_search_passages_file ON search_passages (library_root, file, sha256)
      `;
      yield* sql`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
          passage_id UNINDEXED,
          library_root UNINDEXED,
          file UNINDEXED,
          title,
          heading,
          body,
          tokenize='unicode61 remove_diacritics 2'
        )
      `;
    }),

    "0004_active_call_unique_index": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_paid_call_active_unique
        ON paid_call_ledger (dig_handle, tool, args_hash)
        WHERE status IN ('pending_approval', 'dispatched')
      `;
    }),
  }),
});

export interface DigDbMetaService {
  readonly filename: string;
}

export class DigDbMeta extends Context.Service<DigDbMeta, DigDbMetaService>()("dig/DigDbMeta") {}

/**
 * Open (or create) the SQLite database at `filename` (`:memory:` allowed for tests),
 * ensure 0600 permissions for on-disk files, and run all pending migrations.
 */
export function makeDigDbLayer(
  filename: string,
): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient | DigDbMeta, unknown> {
  const prep = Layer.effectDiscard(
    Effect.gen(function* () {
      if (filename !== ":memory:") {
        yield* Effect.tryPromise(() => mkdir(dirname(filename), { recursive: true, mode: 0o700 }));
      }
    }),
  );

  const clientLayer = SqliteClient.layer({
    filename,
    disableWAL: filename === ":memory:",
  });

  const migrateLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* runMigrations;
      if (filename !== ":memory:") {
        for (const f of [filename, `${filename}-wal`, `${filename}-shm`]) {
          yield* Effect.tryPromise(() => chmod(f, 0o600)).pipe(Effect.ignore);
        }
      }
    }),
  );

  const metaLayer = Layer.succeed(DigDbMeta, DigDbMeta.of({ filename }));

  return Layer.mergeAll(
    metaLayer,
    migrateLayer.pipe(Layer.provideMerge(clientLayer), Layer.provide(prep)),
  );
}
