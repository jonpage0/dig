# Selected frontend component provenance

`timeline.tsx` is the free Base UI Timeline component from ReUI's
`base-nova` registry, retrieved on 2026-10-20:
<https://reui.io/r/base-nova/timeline.json>.
Its documentation is <https://reui.io/docs/components/base/timeline>.
The import of `cn` is changed to Dig's local shadcn-style `clsx` /
`tailwind-merge` utility; the timeline API and rendering remain upstream's.
The MIT license is retained in `ReUI-LICENSE.md` and ships in the plugin.
No ReUI Pro component, template, subscription or runtime service is used.

The compact Button, Card, Badge, Disclosure, Dialog and Tabs wrappers follow
shadcn's source-owned component convention, with Base UI primitives for
interaction. Their CSS maps semantic tokens to the host MCP stylesheet.
The wrappers are Dig code rather than downloaded shadcn registry files.

`frame.tsx` and `icon-tile.tsx` are adapted from the free ReUI `base-nova`
registry, retrieved on 2026-10-20:
<https://reui.io/r/base-nova/frame.json> and
<https://reui.io/r/base-nova/icon-tile.json>.
Documentation: <https://reui.io/docs/components/base/frame> and
<https://reui.io/docs/components/base/icon-tile>.
Their upstream class lists and component composition are retained. The `cn`
import points to Dig's existing utility, and the static variant selection uses
that same utility instead of adding `class-variance-authority`. React is imported
explicitly for both development and bundled JSX transforms. The upstream MIT
notice, verified against <https://github.com/keenthemes/reui/blob/main/LICENSE.md>,
is the existing `ReUI-LICENSE.md` shipped with the plugin.
