# Composer pills container query implementation

## Goal

The desktop composer control row contains these pills:

- `PermissionPill`
- `GoalToggle`
- `ModelPill`

When the composer itself becomes narrow, for example after opening the right
side panel, those pills should collapse their text labels and keep only the
icon/status dot. The trigger must be the composer's available width, not the
viewport width, so this uses CSS container queries rather than `@media`.

## Previous failure mode

The first implementation put Tailwind's `@container` utility on the rounded
composer card, the same element that contains the textarea and the controls.
That generated `container-type: inline-size`.

In the dock-open + session-switch reflow path, this was observed to collapse
the composer card and then the textarea subtree:

- normal card height was about `96px`;
- the container-query card dropped to about `54px`;
- the inner `div.relative` and textarea were then measured at `0px`;
- manually changing the textarea inline height did not recover the UI because
  the containing block had already collapsed;
- changing display temporarily forced a fresh layout and made the composer
  appear again.

The textarea auto-height code was not the root cause: it still measured the
textarea content at the expected minimum height. The unstable piece was the
layout containment boundary sitting on an ancestor that participates in the
main chat flex column and owns the textarea's block-size contribution.

## Stable structure

`ChatView.tsx` now keeps the rounded composer card out of the container-query
tree:

```tsx
<div className="min-w-[300px] rounded-xl border bg-card p-2 shadow-sm">
  <div className="relative">
    <textarea className="max-h-[200px] min-h-[36px] ..." />
  </div>

  <div className="@container/composer-controls mt-1 min-h-8 w-full min-w-0">
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">...</div>
      <div className="flex min-w-0 items-center justify-end gap-1.5">...</div>
    </div>
  </div>
</div>
```

The important detail is the dedicated wrapper:

```txt
@container/composer-controls mt-1 min-h-8 w-full min-w-0
```

It is a block-level width probe after the textarea, not the card itself and not
the flex row whose content is changing. Its width follows the composer card,
but its containment cannot remove the textarea's height contribution. Naming
the container also prevents the pill classes from accidentally binding to a
future nested or outer container.

This avoids the earlier "move `@container` to the controls row" issue because
the flex row is no longer the query container. The wrapper has a stable
`w-full` inline size; the row inside it can shrink labels without changing the
query basis.

## Pill behavior

The pills use Tailwind v4.3 named container variants:

```tsx
@max-[520px]/composer-controls:hidden
```

At `<= 520px` composer-control width:

- `PermissionPill` keeps only the permission tone dot;
- `GoalToggle` keeps only the target icon;
- `ModelPill` keeps only the zap icon;
- dropdown chevrons and text labels are hidden;
- `title` and `aria-label` still expose the current state.

The generated CSS was verified in the renderer build:

```css
.\@container\/composer-controls {
  container: composer-controls / inline-size;
}

@container composer-controls not (min-width: 520px) {
  .\@max-\[520px\]\/composer-controls\:hidden {
    display: none;
  }
}
```

## Verification

Run from `packages/desktop`:

```bash
bunx tsc --noEmit
bun run build:renderer
```

Both commands passed after this implementation.
