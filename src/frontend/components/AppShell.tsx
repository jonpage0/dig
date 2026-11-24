import React, { useEffect, useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { GLYPHS } from "../../glyphs.ts";
import { VERSION } from "../../version.ts";
import { plural } from "../../ui/format.ts";
import {
  libraryAtom,
  liveProgressAtom,
  resultData,
  sseStatusAtom,
  useDigSse,
} from "../state/atoms.ts";
import { useActiveActivity, useDigCatalog, useSourceLogoMap } from "../state/catalog.ts";
import { renderGlyphShapes, SourceIcon } from "./SourceIcon.tsx";
import { cn } from "../shared/utils.ts";

const NAV_ITEMS = [
  { to: "/" as const, label: "Library", match: (path: string) => path === "/" || path.startsWith("/dig/") },
  { to: "/trail" as const, label: "Trail", match: (path: string) => path === "/trail" },
  { to: "/sources" as const, label: "Sources", match: (path: string) => path === "/sources" },
  { to: "/setup" as const, label: "Setup", match: (path: string) => path === "/setup" },
  { to: "/settings" as const, label: "Settings", match: (path: string) => path === "/settings" },
  { to: "/about" as const, label: "About", match: (path: string) => path === "/about" },
];

function elapsedSeconds(iso: string, now: number): string {
  const sec = Math.max(0, Math.round((now - (Date.parse(iso) || now)) / 1000));
  return sec < 120 ? `${sec}s` : `${Math.round(sec / 60)}m`;
}

export function AppShell() {
  // Mount the single root SSE listener (`EventSource("/api/events")`).
  useDigSse();

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const libraryResult = useAtomValue(libraryAtom);
  const sseStatus = useAtomValue(sseStatusAtom);
  const live = useAtomValue(liveProgressAtom);

  const snapshot = resultData(libraryResult);
  const catalog = useDigCatalog(snapshot);
  const logoMap = useSourceLogoMap(snapshot);
  const { activeCalls } = useActiveActivity(snapshot, live);

  // Local 1-second visual elapsed timer ONLY while calls are actively running (zero network calls).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (activeCalls.length === 0) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeCalls.length]);

  const enabledCount = snapshot?.sources.filter((s) => s.enabled).length;
  const totalCount = snapshot?.sources.length;
  const pendingApprovalCount = (live.hasSnapshot ? live.pendingApprovals : (snapshot?.pendingApprovals ?? [])).length;
  const sseLabel =
    sseStatus === "open"
      ? activeCalls.length > 0
        ? `Live · ${plural(activeCalls.length, "call")} running`
        : "Live"
      : sseStatus === "unauthorized"
        ? "Session expired"
        : sseStatus === "reconnecting"
          ? "Reconnecting…"
          : "Connecting…";

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-6">
            <Link
              to="/"
              className="flex items-center gap-2.5 text-foreground no-underline hover:opacity-90"
            >
              <span
                className="inline-flex size-7 items-center justify-center rounded-lg bg-[linear-gradient(135deg,#1d4a80,#3d86d4)] text-white shadow-xs"
                aria-hidden="true"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {renderGlyphShapes(GLYPHS.shovel)}
                </svg>
              </span>
              <span className="text-base font-semibold tracking-tight">Dig</span>
            </Link>

            <nav aria-label="Primary navigation" className="flex flex-wrap items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const active = item.match(pathname);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium no-underline transition-colors",
                      active
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )}
                  >
                    {item.label}
                    {item.to === "/trail" && (activeCalls.length > 0 || pendingApprovalCount > 0) && (
                      <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
                        {activeCalls.length + pendingApprovalCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
            title={`Event stream status: ${sseStatus}`}
          >
            <span
              className="dig-live-dot"
              data-state={activeCalls.length > 0 ? "running" : sseStatus}
              aria-hidden="true"
            />
            <span>{sseLabel}</span>
          </div>
        </div>
      </header>

      {activeCalls.length > 0 && (
        <div
          role="region"
          aria-label="Running provider calls"
          className="border-b border-border bg-accent/60"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2 text-xs sm:px-6">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <span className="dig-live-dot" data-state="running" aria-hidden="true" />
              <strong className="font-medium text-accent-foreground">
                {plural(activeCalls.length, "active call")}
              </strong>
              <div className="flex flex-wrap items-center gap-2">
                {activeCalls.slice(0, 3).map((call) => (
                  <span
                    key={call.callId}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-foreground"
                  >
                    <SourceIcon id={call.source} logo={logoMap.get(call.source)} size="xs" />
                    <span className="font-medium">{catalog.label(call.source)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{call.tool}</span>
                    {call.progress?.message && (
                      <span className="max-w-52 truncate text-muted-foreground">
                        · {call.progress.message}
                      </span>
                    )}
                    <span className="tabular-nums text-muted-foreground">
                      {elapsedSeconds(call.startedAt, now)}
                    </span>
                  </span>
                ))}
                {activeCalls.length > 3 && (
                  <span className="text-muted-foreground">+{activeCalls.length - 3} more</span>
                )}
              </div>
            </div>
            <Link
              to="/trail"
              className="shrink-0 font-medium text-primary no-underline hover:underline"
            >
              Inspect live trail →
            </Link>
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>

      <footer className="border-t border-border bg-card/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-5 gap-y-2 px-4 py-3.5 text-xs text-muted-foreground sm:px-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>Dig {snapshot?.version ?? VERSION}</span>
            {enabledCount !== undefined && totalCount !== undefined && (
              <span>
                {enabledCount} of {totalCount} sources enabled
              </span>
            )}
            {snapshot && (
              <span>
                {snapshot.keepRaw ? "Originals retained" : "Reports only (originals off)"}
              </span>
            )}
          </div>
          {snapshot?.library && (
            <details className="text-right">
              <summary className="cursor-pointer select-none hover:text-foreground">
                Library location
              </summary>
              <p className="mb-0 mt-1 break-all font-mono text-[11px] text-foreground">
                {snapshot.library}
              </p>
            </details>
          )}
        </div>
      </footer>
    </div>
  );
}
