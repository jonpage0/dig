import { Context, Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect";
import { knownSecrets, redactText } from "./secrets.ts";
import type { ToolProgress } from "./plugin.ts";

/**
 * Live daemon progress & event hub powered by Effect `SubscriptionRef` + `PubSub`.
 * Feeds both MCP `notifications/progress` callbacks and the Web SPA's typed SSE `/events` stream.
 */

export interface ActiveCall {
  readonly callId: string;
  readonly dig: string;
  readonly project: string;
  readonly source: string;
  readonly tool: string;
  readonly startedAt: string;
  readonly progress?: LiveProgress;
}

export interface LiveProgress extends ToolProgress {
  readonly at: string;
}

export type DigEvent =
  | { readonly type: "job_started"; readonly call: ActiveCall }
  | { readonly type: "job_progress"; readonly callId: string; readonly progress: LiveProgress }
  | { readonly type: "job_finished"; readonly callId: string; readonly status: string }
  | { readonly type: "library_changed"; readonly at: string; readonly dig?: string }
  | { readonly type: "settings_changed"; readonly at: string }
  | { readonly type: "approval_requested"; readonly code: string; readonly dig: string; readonly tool: string };

export interface ProgressHubService {
  readonly register: (call: Omit<ActiveCall, "startedAt">) => Effect.Effect<void>;
  readonly update: (callId: string, progress: ToolProgress) => Effect.Effect<void>;
  readonly finish: (callId: string, status: string) => Effect.Effect<void>;
  readonly publish: (event: DigEvent) => Effect.Effect<void>;
  readonly activeCalls: () => Effect.Effect<readonly ActiveCall[]>;
  readonly progressOf: (callId: string) => Effect.Effect<LiveProgress | undefined>;
  readonly stream: () => Stream.Stream<DigEvent>;
  readonly subscribeCall: (callId: string, listener: (p: LiveProgress) => void) => () => void;
}

export class ProgressHub extends Context.Service<ProgressHub, ProgressHubService>()("dig/ProgressHub") {
  static readonly Live = Layer.effect(
    ProgressHub,
    Effect.gen(function* () {
      const activeRef = yield* SubscriptionRef.make<ReadonlyMap<string, ActiveCall>>(new Map());
      const pubsub = yield* PubSub.sliding<DigEvent>(256);
      const callListeners = new Map<string, Set<(p: LiveProgress) => void>>();

      const notifyCall = (callId: string, progress: LiveProgress) => {
        const set = callListeners.get(callId);
        if (!set) return;
        for (const fn of [...set]) {
          try {
            fn(progress);
          } catch {}
        }
      };

      return ProgressHub.of({
        register: (call) =>
          Effect.gen(function* () {
            const entry: ActiveCall = { ...call, startedAt: new Date().toISOString() };
            yield* SubscriptionRef.update(activeRef, (m) => {
              const next = new Map(m);
              next.set(call.callId, entry);
              return next;
            });
            yield* PubSub.publish(pubsub, { type: "job_started", call: entry });
          }),

        update: (callId, update) =>
          Effect.gen(function* () {
            const entry: LiveProgress = {
              progress: update.progress,
              ...(update.total !== undefined ? { total: update.total } : {}),
              message: redactText(update.message, knownSecrets()),
              at: new Date().toISOString(),
            };
            yield* SubscriptionRef.update(activeRef, (m) => {
              const existing = m.get(callId);
              if (!existing) return m;
              const next = new Map(m);
              next.set(callId, { ...existing, progress: entry });
              return next;
            });
            notifyCall(callId, entry);
            yield* PubSub.publish(pubsub, { type: "job_progress", callId, progress: entry });
          }),

        finish: (callId, status) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.update(activeRef, (m) => {
              if (!m.has(callId)) return m;
              const next = new Map(m);
              next.delete(callId);
              return next;
            });
            callListeners.delete(callId);
            yield* PubSub.publish(pubsub, { type: "job_finished", callId, status });
          }),

        publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),

        activeCalls: () =>
          Effect.map(SubscriptionRef.get(activeRef), (m) => [...m.values()]),

        progressOf: (callId) =>
          Effect.map(SubscriptionRef.get(activeRef), (m) => m.get(callId)?.progress),

        stream: () => Stream.fromPubSub(pubsub),

        subscribeCall: (callId, listener) => {
          let set = callListeners.get(callId);
          if (!set) {
            set = new Set();
            callListeners.set(callId, set);
          }
          set.add(listener);
          return () => {
            set?.delete(listener);
            if (set?.size === 0) callListeners.delete(callId);
          };
        },
      });
    }),
  );
}
