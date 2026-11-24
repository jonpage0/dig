import React, { useMemo } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import { httpUrl } from "../../ui/dom.ts";
import { decodeEntities } from "../../ui/format.ts";

const HEADING_OFFSET = 2;
const MAX_HEADING = 6;

interface OutlineHeading {
  readonly id: string;
  readonly depth: number;
  readonly text: string;
}

function renderInline(tokens: readonly Token[] | undefined, keyPrefix: string): React.ReactNode {
  if (!tokens?.length) return null;
  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-i-${idx}`;
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        return t.tokens ? (
          <React.Fragment key={key}>{renderInline(t.tokens, key)}</React.Fragment>
        ) : (
          <React.Fragment key={key}>{decodeEntities(t.text)}</React.Fragment>
        );
      }
      case "escape": {
        const t = token as Tokens.Escape;
        return <React.Fragment key={key}>{t.text}</React.Fragment>;
      }
      case "strong": {
        const t = token as Tokens.Strong;
        return <strong key={key}>{renderInline(t.tokens, key)}</strong>;
      }
      case "em": {
        const t = token as Tokens.Em;
        return <em key={key}>{renderInline(t.tokens, key)}</em>;
      }
      case "del": {
        const t = token as Tokens.Del;
        return <del key={key}>{renderInline(t.tokens, key)}</del>;
      }
      case "codespan": {
        const t = token as Tokens.Codespan;
        return <code key={key}>{decodeEntities(t.text)}</code>;
      }
      case "br":
        return <br key={key} />;
      case "checkbox": {
        const t = token as Tokens.Checkbox;
        return (
          <span
            key={key}
            role="img"
            aria-label={t.checked ? "done" : "not done"}
            className="mr-1.5 inline-block select-none"
          >
            {t.checked ? "☑" : "☐"}
          </span>
        );
      }
      case "link": {
        const t = token as Tokens.Link;
        const href = httpUrl(t.href);
        const content = renderInline(t.tokens, key);
        if (href) {
          return (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={t.title ? decodeEntities(t.title) : undefined}
            >
              {content}
            </a>
          );
        }
        const rawTarget = typeof t.href === "string" ? t.href.trim() : "";
        return rawTarget && !rawTarget.startsWith("#") && rawTarget !== t.text ? (
          <React.Fragment key={key}>
            {content}{" "}
            <code className="text-xs text-muted-foreground">{rawTarget}</code>
          </React.Fragment>
        ) : (
          <React.Fragment key={key}>{content}</React.Fragment>
        );
      }
      case "image": {
        // Never auto-fetch remote images from untrusted reports.
        const t = token as Tokens.Image;
        const label = `Image: ${t.text ? decodeEntities(t.text) : "untitled"}`;
        const href = httpUrl(t.href);
        return href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs no-underline hover:underline"
          >
            {label} ↗
          </a>
        ) : (
          <span
            key={key}
            className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            {label}
          </span>
        );
      }
      default: {
        const fallback = (token as { text?: string; raw?: string }).text ?? token.raw ?? "";
        return <React.Fragment key={key}>{fallback}</React.Fragment>;
      }
    }
  });
}

function headingPlainText(token: Tokens.Heading): string {
  const plain = (tokens: readonly Token[] | undefined): string =>
    (tokens ?? [])
      .map((t) => {
        const sub = (t as { tokens?: readonly Token[] }).tokens;
        if (sub) return plain(sub);
        if (t.type === "escape" || t.type === "codespan" || t.type === "text") {
          return decodeEntities((t as { text?: string }).text ?? "");
        }
        return "";
      })
      .join("");
  return plain(token.tokens).trim() || decodeEntities(token.text);
}

function renderBlocks(
  tokens: readonly Token[] | undefined,
  keyPrefix: string,
  headingState: { index: number },
  idPrefix: string,
): React.ReactNode {
  if (!tokens?.length) return null;
  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-b-${idx}`;
    switch (token.type) {
      case "space":
      case "def":
        return null;

      case "heading": {
        const t = token as Tokens.Heading;
        const level = Math.min(t.depth + HEADING_OFFSET, MAX_HEADING);
        const tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
        const headingId = `${idPrefix}-section-${headingState.index++}`;
        return React.createElement(
          tag,
          { key, id: headingId, tabIndex: -1 },
          renderInline(t.tokens, key),
        );
      }

      case "paragraph": {
        const t = token as Tokens.Paragraph;
        return <p key={key}>{renderInline(t.tokens, key)}</p>;
      }

      case "text": {
        const t = token as Tokens.Text;
        return t.tokens ? (
          <React.Fragment key={key}>{renderInline(t.tokens, key)}</React.Fragment>
        ) : (
          <React.Fragment key={key}>{decodeEntities(t.text)}</React.Fragment>
        );
      }

      case "code": {
        const t = token as Tokens.Code;
        return (
          <div key={key} className="my-4">
            {t.lang && (
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t.lang}
              </div>
            )}
            <pre>
              <code>{t.text}</code>
            </pre>
          </div>
        );
      }

      case "blockquote": {
        const t = token as Tokens.Blockquote;
        return (
          <blockquote key={key}>
            {renderBlocks(t.tokens, key, headingState, idPrefix)}
          </blockquote>
        );
      }

      case "list": {
        const t = token as Tokens.List;
        const ListTag = t.ordered ? "ol" : "ul";
        const start = t.ordered && typeof t.start === "number" && t.start !== 1 ? t.start : undefined;
        return (
          <ListTag key={key} start={start}>
            {t.items.map((item, itemIdx) => {
              const itemKey = `${key}-li-${itemIdx}`;
              return (
                <li key={itemKey} className={item.task ? "dig-task-item" : undefined}>
                  {item.task && (
                    <span
                      role="img"
                      aria-label={item.checked ? "done" : "not done"}
                      className="mr-1.5 inline-block select-none"
                    >
                      {item.checked ? "☑" : "☐"}
                    </span>
                  )}
                  {renderBlocks(item.tokens, itemKey, headingState, idPrefix)}
                </li>
              );
            })}
          </ListTag>
        );
      }

      case "table": {
        const t = token as Tokens.Table;
        return (
          <div key={key} className="dig-table-scroll">
            <table>
              <thead>
                <tr>
                  {t.header.map((cell, cellIdx) => (
                    <th
                      key={`${key}-th-${cellIdx}`}
                      scope="col"
                      style={t.align[cellIdx] ? { textAlign: t.align[cellIdx]! } : undefined}
                    >
                      {renderInline(cell.tokens, `${key}-th-${cellIdx}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.map((row, rowIdx) => (
                  <tr key={`${key}-tr-${rowIdx}`}>
                    {row.map((cell, cellIdx) => (
                      <td
                        key={`${key}-td-${rowIdx}-${cellIdx}`}
                        style={t.align[cellIdx] ? { textAlign: t.align[cellIdx]! } : undefined}
                      >
                        {renderInline(cell.tokens, `${key}-td-${rowIdx}-${cellIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }

      case "hr":
        return <hr key={key} />;

      case "checkbox":
        return renderInline([token], key);

      case "html": {
        // Untrusted HTML is rendered strictly as literal text, never executed.
        const t = token as Tokens.HTML;
        return (
          <pre key={key} className="text-xs text-muted-foreground">
            <code>{t.text}</code>
          </pre>
        );
      }

      default:
        return <p key={key}>{token.raw ?? ""}</p>;
    }
  });
}

function collectHeadings(
  tokens: readonly Token[] | undefined,
  idPrefix: string,
  out: OutlineHeading[],
): void {
  if (!tokens?.length) return;
  for (const token of tokens) {
    if (token.type === "heading") {
      const h = token as Tokens.Heading;
      out.push({
        id: `${idPrefix}-section-${out.length}`,
        depth: h.depth,
        text: headingPlainText(h),
      });
    } else if (token.type === "blockquote") {
      collectHeadings((token as Tokens.Blockquote).tokens, idPrefix, out);
    } else if (token.type === "list") {
      for (const item of (token as Tokens.List).items) {
        collectHeadings(item.tokens, idPrefix, out);
      }
    }
  }
}

/**
 * Pure declarative React JSX Markdown renderer for untrusted reports and answers.
 * Zero `dangerouslySetInnerHTML`: raw HTML renders as literal text, links are http(s)-validated,
 * and remote images are never auto-fetched.
 */
export function MarkdownView({
  markdown,
  showOutline = true,
  idPrefix = "doc",
}: {
  readonly markdown: string;
  readonly showOutline?: boolean;
  readonly idPrefix?: string;
}) {
  const { tokens, outline } = useMemo(() => {
    const lexed = Lexer.lex(markdown, { gfm: true });
    const headings: OutlineHeading[] = [];
    collectHeadings(lexed, idPrefix, headings);
    return { tokens: lexed, outline: headings };
  }, [markdown, idPrefix]);

  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "auto" });
    el.focus({ preventScroll: true });
  };

  const headingState = { index: 0 };

  return (
    <div className="space-y-4">
      {showOutline && outline.length >= 2 && (
        <details className="rounded-lg border border-border bg-secondary/45 px-3.5 py-2.5 text-xs">
          <summary className="cursor-pointer select-none font-medium text-foreground">
            In this document ({outline.length} sections)
          </summary>
          <nav aria-label="Document outline" className="mt-2">
            <ol className="space-y-1">
              {outline.map((item) => (
                <li
                  key={item.id}
                  style={{ paddingLeft: `${Math.max(0, item.depth - 1) * 12}px` }}
                >
                  <button
                    type="button"
                    onClick={() => jumpTo(item.id)}
                    className="text-left text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {item.text}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </details>
      )}
      <div className="dig-prose">
        {renderBlocks(tokens, idPrefix, headingState, idPrefix)}
      </div>
    </div>
  );
}
