import React, { useMemo, useState } from "react";
import { costSummary } from "../../core/cost.ts";
import type { Receipt } from "../../core/library.ts";
import { callWord, patternOf } from "../../status.ts";
import type { UiCatalog } from "../../ui/catalog.ts";
import { httpUrl } from "../../ui/dom.ts";
import {
  bodies,
  evidence,
  hasSourceView,
  ITEM_NOUNS,
  sentenceText,
  type ConnectorState,
  type EvidenceItem,
  type EvidenceResult,
} from "../../ui/evidence/index.ts";
import {
  absTime,
  basename,
  callOutcome,
  costText,
  duration,
  num,
  plural,
} from "../../ui/format.ts";
import { Badge, Disclosure } from "../shared/components.tsx";

const PERCENT = 100;

function statusTone(status: string): "neutral" | "success" | "partial" | "warning" | "muted" {
  const pattern = patternOf(callWord(status));
  if (pattern === "solid") return "success";
  if (pattern === "stripes") return "partial";
  if (pattern === "warning") return "warning";
  return "muted";
}

function itemsHeading(items: readonly EvidenceItem[]): string {
  const kinds = [...new Set(items.map((item) => item.kind))];
  const nouns = kinds.length === 1 ? ITEM_NOUNS[kinds[0]] : undefined;
  return nouns ? plural(items.length, nouns[0], nouns[1]) : plural(items.length, "item");
}

function ConnectorTable({ connectors }: { readonly connectors: readonly ConnectorState[] }) {
  return (
    <div className="space-y-2">
      <h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Connector health
      </h4>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-secondary/60">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Connector
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                State
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Results
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Note
              </th>
            </tr>
          </thead>
          <tbody>
            {connectors.map((c, idx) => (
              <tr key={`${c.name}-${idx}`} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2">{c.state}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {c.results === undefined ? "" : num(c.results)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{c.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EvidenceItemCard({ item }: { readonly item: EvidenceItem }) {
  const href = httpUrl(item.url);
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <p className="m-0 text-sm font-medium leading-snug text-foreground">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </p>
      {item.meta.length > 0 && (
        <p className="mb-0 mt-1 text-xs text-muted-foreground">{item.meta.join(" · ")}</p>
      )}
      {item.excerpt && (
        <p className="mb-0 mt-2 text-xs leading-relaxed text-foreground/90">{item.excerpt}</p>
      )}
      {item.outcomes && item.outcomes.length > 0 && (
        <ul className="mb-0 mt-2 list-disc space-y-0.5 pl-4 text-xs text-foreground">
          {item.outcomes.map((o, idx) => (
            <li key={idx}>
              <span className="font-medium">{o.label}:</span> {(o.probability * PERCENT).toFixed(1)}%
              {typeof o.dayMove === "number" && (
                <span className="text-muted-foreground">
                  {" "}
                  ({o.dayMove >= 0 ? "+" : ""}
                  {(o.dayMove * PERCENT).toFixed(1)} pts today)
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {item.links && item.links.length > 0 && (
        <p className="mb-0 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {item.links.map((l, idx) => {
            const url = httpUrl(l.url);
            if (!url) return null;
            return (
              <a
                key={`${l.label}-${idx}`}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {l.label} ↗
              </a>
            );
          })}
        </p>
      )}
    </li>
  );
}

interface ParsedRawFile {
  readonly parsed: Record<string, unknown> | undefined;
  readonly preview: {
    readonly result: EvidenceResult;
    readonly sentence: string;
    readonly specialized: boolean;
  } | null;
  readonly responses: readonly { readonly label?: unknown; readonly status?: unknown }[];
}

/**
 * Displays a retained original provider response JSON with source-shaped evidence previews
 * (`src/ui/evidence/index.ts`), connector health tables, receipt facts, and lazy verbatim JSON.
 */
export function RawEvidenceView({
  file,
  text,
  receipt,
  catalog,
}: {
  readonly file: string;
  readonly text: string;
  readonly receipt?: Receipt;
  readonly catalog: UiCatalog;
}) {
  const analysis = useMemo<ParsedRawFile>(() => {
    let parsed: Record<string, unknown> | undefined;
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = undefined;
    }

    const effectiveReceipt = receipt ?? {
      tool: typeof parsed?.tool === "string" ? parsed.tool : "unknown",
      source: "",
      status: "",
      args: {},
    };

    let preview: ParsedRawFile["preview"] = null;
    try {
      const result = evidence(effectiveReceipt, parsed ? bodies(parsed) : [], catalog);
      preview = {
        result,
        sentence: sentenceText(result),
        specialized:
          typeof effectiveReceipt.source === "string" &&
          hasSourceView(effectiveReceipt.source) &&
          result.items.length > 0,
      };
    } catch {
      preview = null;
    }

    const responses = Array.isArray(parsed?.responses)
      ? (parsed.responses as readonly { readonly label?: unknown; readonly status?: unknown }[])
      : [];

    return { parsed, preview, responses };
  }, [text, receipt, catalog]);

  const defaultJsonOpen = !analysis.preview?.specialized;
  const [jsonOpen, setJsonOpen] = useState(defaultJsonOpen);

  // Lazy-format verbatim JSON only when expanded so large responses stay instant.
  const prettyJson = useMemo(() => {
    if (!jsonOpen) return "";
    if (analysis.parsed === undefined) return text;
    try {
      return JSON.stringify(analysis.parsed, null, 2);
    } catch {
      return text;
    }
  }, [jsonOpen, analysis.parsed, text]);

  const toolName = receipt?.tool ?? (typeof analysis.parsed?.tool === "string" ? analysis.parsed.tool : "unknown");
  const argsObj = receipt?.args ?? {};
  const receiptSummary = receipt ? costSummary([receipt]) : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="m-0 text-sm font-medium text-foreground">
          {analysis.preview?.sentence ??
            "The source preview could not be rendered. The original JSON is shown below."}
        </p>
        {receipt ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge tone={statusTone(receipt.status)}>{callOutcome(receipt.status)}</Badge>
            <span>{catalog.label(receipt.source)}</span>
            {receipt.at && (
              <>
                <span aria-hidden="true">·</span>
                <span>{absTime(receipt.at)}</span>
              </>
            )}
            {typeof receipt.ms === "number" && (
              <>
                <span aria-hidden="true">·</span>
                <span>{duration(receipt.ms)}</span>
              </>
            )}
            {receiptSummary && (
              <>
                <span aria-hidden="true">·</span>
                <span>{costText(receiptSummary)}</span>
              </>
            )}
          </div>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">
            No call receipt matched this file; showing retained response contents directly.
          </p>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-secondary/35 p-3 text-xs">
        <dt className="font-medium text-muted-foreground">Retrieval</dt>
        <dd className="m-0 break-all font-mono text-foreground">{receipt?.id ?? basename(file)}</dd>

        <dt className="font-medium text-muted-foreground">Tool</dt>
        <dd className="m-0 font-mono text-foreground">{toolName}</dd>

        {receipt?.error && (
          <>
            <dt className="font-medium text-destructive">Error</dt>
            <dd className="m-0 text-destructive">{receipt.error}</dd>
          </>
        )}

        {analysis.responses.length > 0 && (
          <>
            <dt className="font-medium text-muted-foreground">HTTP responses</dt>
            <dd className="m-0 text-foreground">
              {analysis.responses
                .map(
                  (r) =>
                    `${String(r?.label ?? "response")} · HTTP ${
                      r?.status !== undefined ? String(r.status) : "unrecorded"
                    }`,
                )
                .join("; ")}
            </dd>
          </>
        )}

        {Object.keys(argsObj).length > 0 && (
          <>
            <dt className="font-medium text-muted-foreground">Arguments</dt>
            <dd className="m-0 overflow-x-auto">
              <pre className="m-0 rounded border border-border bg-card p-2 text-[11.5px] leading-snug">
                <code>{JSON.stringify(argsObj, null, 2)}</code>
              </pre>
            </dd>
          </>
        )}
      </dl>

      {analysis.preview?.result.connectors && analysis.preview.result.connectors.length > 0 && (
        <ConnectorTable connectors={analysis.preview.result.connectors} />
      )}

      {analysis.preview && analysis.preview.result.items.length > 0 && (
        <div className="space-y-2">
          <h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {itemsHeading(analysis.preview.result.items)} in this response
          </h4>
          <ol className="m-0 list-none space-y-2 p-0">
            {analysis.preview.result.items.map((item, idx) => (
              <EvidenceItemCard key={`${item.key}-${idx}`} item={item} />
            ))}
          </ol>
        </div>
      )}

      {analysis.preview && !analysis.preview.specialized && (
        <p className="m-0 text-xs text-muted-foreground">
          {analysis.parsed === undefined
            ? "This file is not valid JSON; its text is shown as saved."
            : receipt && hasSourceView(receipt.source)
              ? "No preview items recognized in this response; the original JSON is shown below. A missing preview is not evidence that the source returned nothing."
              : "No source-specific preview applies to this response; inspect the original JSON below."}
        </p>
      )}

      <Disclosure
        title={`Original JSON · ${plural(text.length, "character")}`}
        open={jsonOpen}
        onOpenChange={setJsonOpen}
      >
        <pre className="m-0 max-h-[520px] overflow-auto rounded-lg border border-border bg-secondary/40 p-3 text-[11.5px] leading-relaxed text-foreground">
          <code>{prettyJson}</code>
        </pre>
      </Disclosure>
    </div>
  );
}
