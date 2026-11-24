import React from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { VERSION } from "../../version.ts";
import { libraryAtom, resultData } from "../state/atoms.ts";
import { Badge, Disclosure } from "../shared/components.tsx";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../shared/frame.tsx";

export function AboutPage() {
  const libraryResult = useAtomValue(libraryAtom);
  const snapshot = resultData(libraryResult);
  const serverVersion = snapshot?.version ?? null;
  const versionMatch = !serverVersion || serverVersion === VERSION;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="m-0 text-2xl font-semibold tracking-tight">About Dig</h1>
        <p className="mb-0 mt-1 text-sm text-muted-foreground">
          Local-first research library with plain-file records, retained provider evidence, and
          honest cost accounting.
        </p>
      </div>

      <Frame spacing="sm">
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <FrameTitle>Version &amp; local service</FrameTitle>
            <FrameDescription>
              One localhost daemon shared across Codex, Claude Code, and Antigravity.
            </FrameDescription>
          </div>
          <Badge tone={versionMatch ? "success" : "partial"}>
            {serverVersion
              ? versionMatch
                ? `Dig ${VERSION}`
                : `UI ${VERSION} · Service ${serverVersion}`
              : `Dig ${VERSION}`}
          </Badge>
        </FrameHeader>
        <FramePanel>
          <dl className="m-0 grid gap-4 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Web UI version</dt>
              <dd className="m-0 mt-1 font-mono text-sm font-medium text-foreground">{VERSION}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Daemon version</dt>
              <dd className="m-0 mt-1 font-mono text-sm font-medium text-foreground">
                {serverVersion ?? "Connecting…"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Live updates</dt>
              <dd className="m-0 mt-1 text-sm font-medium text-foreground">
                Server-Sent Events (<code>/api/events</code>)
              </dd>
            </div>
          </dl>
        </FramePanel>
      </Frame>

      <Frame spacing="sm">
        <FrameHeader>
          <FrameTitle>Storage contract &amp; paths</FrameTitle>
          <FrameDescription>
            Plain Markdown reports and JSONL receipts on disk are the source of truth;{" "}
            <code>dig.sqlite</code> is a rebuildable local index and durable paid-call ledger.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="divide-y divide-border text-xs">
          <div className="flex flex-col gap-1 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <strong className="block font-medium text-foreground">Research library</strong>
              <span className="text-muted-foreground">
                Saved questions, source reports, answers, call receipts, and retained raw JSON
              </span>
            </div>
            <code className="break-all rounded bg-secondary px-2 py-1 text-foreground">
              {snapshot?.library ?? "~/.local/share/dig/library"}
            </code>
          </div>

          <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <strong className="block font-medium text-foreground">Settings file</strong>
              <span className="text-muted-foreground">
                Single inspectable TOML authority edited by Settings, Setup, CLI, and MCP
              </span>
            </div>
            <code className="break-all rounded bg-secondary px-2 py-1 text-foreground">
              {snapshot?.configPath ?? "~/.local/share/dig/config.toml"}
            </code>
          </div>

          <div className="flex flex-col gap-1 py-3 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <strong className="block font-medium text-foreground">Credentials file</strong>
              <span className="text-muted-foreground">
                Mode <code>0600</code> local key store — never rendered back or sent to chat models
              </span>
            </div>
            <code className="break-all rounded bg-secondary px-2 py-1 text-foreground">
              {snapshot?.keysPath ?? "~/.local/share/dig/keys.env"}
            </code>
          </div>
        </FramePanel>
      </Frame>

      <div className="grid gap-4 md:grid-cols-3">
        <Frame spacing="sm">
          <FramePanel className="space-y-1.5">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Untrusted evidence
            </p>
            <h2 className="m-0 text-sm font-semibold text-foreground">
              Evidence, never instructions
            </h2>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              Provider responses and source reports are rendered safely as allowlisted text and
              links without raw HTML execution or auto-fetched remote images. Research runs in your
              assistant; this UI inspects the saved record.
            </p>
          </FramePanel>
        </Frame>

        <Frame spacing="sm">
          <FramePanel className="space-y-1.5">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Honest costs
            </p>
            <h2 className="m-0 text-sm font-semibold text-foreground">
              Original units, never coerced
            </h2>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              Provider-reported USD, credits, and API read counts stay separated in their original
              units. Unreported or interrupted paid calls stay marked unknown — never coerced to
              $0, and never automatically retried.
            </p>
          </FramePanel>
        </Frame>

        <Frame spacing="sm">
          <FramePanel className="space-y-1.5">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Local privacy
            </p>
            <h2 className="m-0 text-sm font-semibold text-foreground">
              Keys stay on this machine
            </h2>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              API credentials entered in the{" "}
              <Link to="/setup" search={{ step: 3 }} className="text-primary hover:underline">
                Setup Wizard
              </Link>{" "}
              go straight over localhost to <code>keys.env</code> (0600) and are cleared from page
              memory immediately after saving.
            </p>
          </FramePanel>
        </Frame>
      </div>

      <Frame spacing="sm">
        <FramePanel>
          <Disclosure title="Open-source credits & licenses">
            <ul className="m-0 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
              <li>Dig is MIT-licensed.</li>
              <li>
                Built with React 19, Effect 4 &amp; <code>@effect/atom-react</code>, TanStack
                Router, Base UI, selected ReUI components (MIT), Tailwind CSS, and{" "}
                <code>marked</code>.
              </li>
              <li>Interface glyphs from Lucide (ISC License).</li>
              <li>
                Optional Papers bridge integrates <code>paper-search-mcp</code> (MIT License).
              </li>
              <li>
                Source brand logos belong to their respective owners and identify each provider;
                Dig is not affiliated with or endorsed by them.
              </li>
            </ul>
          </Disclosure>
        </FramePanel>
      </Frame>
    </div>
  );
}
