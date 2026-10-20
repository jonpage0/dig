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
