# Design Studio repository format

The durable source file ends in `.codesign.json`. Version 2 is the current format; the panel still
opens and saves strict v1 documents without rewriting them until a v2-only feature is used.

```json
{
  "format": "codeshell.design",
  "version": 2,
  "name": "Product UI",
  "canvas": {
    "width": 1440,
    "height": 960,
    "background": "#f5f5f2"
  },
  "tokens": {
    "colors": [{ "name": "Ink", "value": "#171717" }]
  },
  "nodes": []
}
```

## Repository binding

The panel treats the current repository as the design workspace:

1. Restore an unsaved recovery snapshot for this repository, when one exists.
2. Reopen the last `.codesign.json` used in this repository.
3. Otherwise open the most recently modified design below `designs/`.
4. If no design exists, show a blank repo document at `designs/design.codesign.json`.

The selected path and recovery data are scoped to the repository root, so different projects do not
share a design. While the panel is visible it checks the active source file for changes. A clean
canvas reloads Agent or editor changes automatically; a dirty canvas reports a conflict instead of
overwriting either version.

## Nodes and layers

Every node has a stable `id`, a human-readable `name`, geometry, fill and stroke, opacity, rotation,
corner radius, visibility, and lock state. `notes` can carry implementation, interaction,
responsive, or accessibility guidance without rendering it.

Version 2 supports:

- primitives: `rectangle`, `ellipse`, and `text`;
- containers: `frame`, `group`, and `component`;
- reusable references: `instance`, linked by `componentId`.

Containers remain root nodes in v2. Their direct children use `parentId`, keep absolute document
coordinates, and must appear immediately after the container in the node array. This one-level
structure keeps diffs compact and predictable. Moving, copying, ordering, locking, hiding, or
deleting a container acts on its child block.

Frames and components may use `clipContent`. Container visibility, opacity, and rotation cascade to
their children in the canvas and SVG export.

## Auto layout

Each v2 container stores:

- `layout`: `none`, `horizontal`, or `vertical`;
- `gap` and `padding`;
- `alignItems`: `start`, `center`, `end`, or `stretch`;
- `justifyContent`: `start`, `center`, `end`, or `space-between`.

Children of an auto-layout container may use `layoutGrow` (`0` or `1`) and `layoutAlign` (`auto`,
`start`, `center`, `end`, or `stretch`). The panel resolves these rules into explicit, rounded
geometry whenever layout-affecting values change. Both the rules and their current result therefore
remain readable in Git and editable by an Agent.

## Components

A `component` is a visible master container. An `instance` stores `componentId`, its own geometry,
visibility, opacity, and rotation. It renders the current master and its direct children, scaled to
the instance bounds. Editing the master updates every instance without copying the child node tree.
Deleting a master also removes its instances to avoid dangling references.

## Determinism and validation

The node array is back-to-front paint order. JSON is pretty-printed with stable property order and a
trailing newline. Hex colors are normalized to lowercase; unknown fields and malformed values are
rejected rather than silently discarded.

Limits are 500 nodes, 32 color variables, and 192 KiB per formatted source document. Generated SVG
is derived output and includes `data-node-id` metadata for review; the JSON remains authoritative.

Use `codeshell-design-v2.schema.json` for current documents and
`codeshell-design-v1.schema.json` for legacy documents. Optional sibling `*.audit.md` files are
deterministic review reports, not design sources.
