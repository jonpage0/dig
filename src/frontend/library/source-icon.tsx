import React from 'react';
import { IconTile } from '../shared/icon-tile';
import { MODULES } from '../../providers/modules.ts';
import { GLYPHS, glyphFor } from '../../glyphs.mjs';

/** Logos remain package-owned symbols on a light tile, never remote images. */
export function SourceIcon({ id }: { id: string }) {
  const module = MODULES.find(module => module.id === id);
  return <IconTile size="sm" variant="outline" className="research-overview-icon">
    {module?.logo ? <svg aria-hidden="true" focusable="false"><use href={`#logo-${module.logo}`} /></svg>
      : <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="research-overview-glyph">
        {GLYPHS[glyphFor(id)].map(([tag, attributes]: [string, Record<string, string>], index: number) => React.createElement(tag, {
          key: index,
          ...Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key.replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase()), value])),
        }))}
      </svg>}
  </IconTile>;
}

