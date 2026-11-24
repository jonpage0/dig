import React from "react";
import type { SourceCard } from "../../core/markdown.ts";
import { patternOf, runWord } from "../../status.ts";
import { num } from "../../ui/format.ts";
import { Badge, Disclosure } from "../shared/components.tsx";

const CARD_SECTIONS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["contradictions", "Contradictions"],
  ["negative_evidence", "Negative evidence"],
  ["follow_up_targets", "Follow-up targets"],
];

function badgeTone(word: string | null): "neutral" | "success" | "partial" | "warning" | "muted" {
  if (!word) return "muted";
  const pattern = patternOf(word);
  if (pattern === "solid") return "success";
  if (pattern === "stripes") return "partial";
  if (pattern === "warning") return "warning";
  return "muted";
}

function scalarText(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

/**
 * Displays a source report's own `source_card` YAML assessment clearly labeled as
 * the source worker's self-report (never an independent check), with verbatim YAML disclosure.
 */
export function SourceCardView({ card }: { readonly card: SourceCard }) {
  const { fields, lists } = card;
  const statusWord = runWord(fields.status);
  const findings = lists.strongest_findings ?? [];

  const facts: Array<{ readonly label: string; readonly value: React.ReactNode }> = [];
  if (statusWord) {
    facts.push({
      label: "Run status",
      value: <Badge tone={badgeTone(statusWord)}>{statusWord}</Badge>,
    });
  }
  const grade = scalarText(fields.evidence_grade);
  if (grade) facts.push({ label: "Evidence grade", value: grade });
  const confidence = scalarText(fields.confidence);
  if (confidence) facts.push({ label: "Confidence", value: confidence });
  const reportedCost = scalarText(fields.reported_cost_usd);
  if (reportedCost) facts.push({ label: "Reported cost (USD)", value: reportedCost });

  return (
    <section
      aria-label="Source report's own assessment"
      className="mb-6 rounded-xl border border-border bg-secondary/40 p-4"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Source report’s own assessment
        </p>
        {card.partial && (
          <Badge tone="partial">Partial parse — inspect verbatim card</Badge>
        )}
      </div>
      <p className="mb-3 mt-0 text-xs text-muted-foreground">
        Written by the source worker in its source card. Dig records it as reported; it is not an
        independent check.
      </p>

      {facts.length > 0 && (
        <dl className="mb-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
          {facts.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className="m-0 font-medium text-foreground">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {findings.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 mt-0 text-xs font-semibold text-foreground">
            Strongest findings, as reported
          </h4>
          <ul className="m-0 list-disc space-y-1 pl-5 text-sm text-foreground">
            {findings.map((finding, idx) => (
              <li key={idx}>{finding}</li>
            ))}
          </ul>
        </div>
      )}

      {CARD_SECTIONS.map(([key, label]) => {
        const items = lists[key];
        if (!items?.length) return null;
        return (
          <Disclosure key={key} title={`${label} (${num(items.length)})`}>
            <ul className="m-0 list-disc space-y-1 pl-5 text-sm text-foreground">
              {items.map((entry, idx) => (
                <li key={idx}>{entry}</li>
              ))}
            </ul>
          </Disclosure>
        );
      })}

      <Disclosure
        title={
          card.partial
            ? "The card as written (part of it is shown only here)"
            : "The card as written (verbatim YAML)"
        }
        defaultOpen={card.partial}
      >
        <pre className="m-0 overflow-x-auto rounded-lg border border-border bg-card p-3 text-xs leading-relaxed text-foreground">
          <code>{card.yaml}</code>
        </pre>
      </Disclosure>
    </section>
  );
}
