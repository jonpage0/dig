import React from "react";
import { GLYPHS, glyphFor, type GlyphShape } from "../../glyphs.ts";
import { IconTile } from "../shared/icon-tile.tsx";
import { cn } from "../shared/utils.ts";

/** Brand logos packaged in `src/logos/*.svg` and injected into the inline SVG sprite. */
const DEFAULT_SOURCE_LOGOS: Readonly<Record<string, string>> = {
  hackernews: "ycombinator",
  exa: "exa",
  github: "github",
  instagram: "instagram",
  linkedin: "linkedin",
  "linkedin-ads": "linkedin",
  polymarket: "polymarket",
  reddit: "reddit",
  "tikhub-reddit": "reddit",
  telegram: "telegram",
  tiktok: "tiktok",
  "tiktok-ads": "tiktok",
  x: "x",
  youtube: "youtube",
};

function camelCaseAttr(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function renderGlyphShapes(shapes: readonly GlyphShape[]): React.ReactNode {
  return shapes.map(([tag, attrs], index) => {
    const props: Record<string, string | number> = { key: index };
    for (const [k, v] of Object.entries(attrs)) {
      props[camelCaseAttr(k)] = v;
    }
    return React.createElement(tag, props);
  });
}

export function SourceIcon({
  id,
  logo,
  size = "sm",
  className,
}: {
  readonly id: string;
  readonly logo?: string;
  readonly size?: "xs" | "sm" | "default" | "lg";
  readonly className?: string;
}) {
  const spriteLogo = logo || DEFAULT_SOURCE_LOGOS[id];
  return (
    <IconTile
      size={size}
      variant="outline"
      className={cn(spriteLogo && "dig-logo-tile", className)}
    >
      {spriteLogo ? (
        <svg aria-hidden="true" focusable="false">
          <use href={`#logo-${spriteLogo}`} />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {renderGlyphShapes(GLYPHS[glyphFor(id)])}
        </svg>
      )}
    </IconTile>
  );
}
