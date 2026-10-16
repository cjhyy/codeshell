# Link service icon sources

`../../credentials/LinkServiceIcon.tsx` embeds the frozen SVG geometry below. The
SVG files in this directory preserve the downloaded sources for provenance and
future review. Rendering makes no network requests and adds no dependency.
Retrieved 2026-10-16.

These marks identify supported third-party services in the Link directory. Brand
names and trademarks remain with their respective owners; the product does not
claim endorsement or affiliation.

## Official brand assets

| Service  | Frozen file and primary source                                                                                                                                                                                                    | Brand guidelines / context                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Figma    | `figma.svg`: **Figma Brand Assets/Figma Icon (Full-color)/Figma Icon (Full-color).svg** from the [official logo download](https://static.figma.com/uploads/4fbf4d754dbbc027ba1530205f8747cd97d532e5) linked by Figma's brand page | [Figma trademark and brand usage guidelines](https://www.figma.com/using-the-figma-brand/)                                                                   |
| GitLab   | `gitlab.svg`: [official press-kit logomark SVG](https://about.gitlab.com/images/press/gitlab-logo-500-rgb.svg)                                                                                                                    | [GitLab press kit](https://about.gitlab.com/press/press-kit/), [brand guidelines](https://design.gitlab.com/brand/overview/)                                 |
| Slack    | `slack.svg`: [official website navigation logo SVG](https://a.slack-edge.com/9cc0056/marketing/img/nav/logo.svg), referenced by the [Slack media-kit page](https://slack.com/media-kit)                                           | [Slack media kit and mark usage](https://slack.com/media-kit)                                                                                                |
| Airtable | `airtable.svg`: [official application favicon SVG](https://airtable.com/images/favicon/baymax/favicon.svg?v=3), referenced by the public logos library linked from the newsroom                                                   | [Airtable newsroom](https://www.airtable.com/newsroom), [official logos library](https://airtable.com/appA7j0QSl46txyIa/shrBPDdtZsWdsQPrX/tblo0X6SRWwtIEZ2J) |

## Simple Icons

The remaining marks come from the official [Simple Icons repository](https://github.com/simple-icons/simple-icons),
version **16.35.0**, pinned to commit
[`4d29a35c954699b389a834aacc97dd6e7e74143c`](https://github.com/simple-icons/simple-icons/commit/4d29a35c954699b389a834aacc97dd6e7e74143c).
Their upstream color/source metadata is in the same commit's
[`data/simple-icons.json`](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/data/simple-icons.json).
A complete copy of the upstream [CC0 license](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/LICENSE.md)
is included as `LICENSE.simple-icons.md`. Also see the upstream
[trademark disclaimer](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/DISCLAIMER.md).

| Service | Exact source                                                                                                                | Source / license                |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| GitHub  | [github.svg](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/icons/github.svg)   | Simple Icons, CC0 1.0 Universal |
| Sentry  | [sentry.svg](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/icons/sentry.svg)   | Simple Icons, CC0 1.0 Universal |
| Vercel  | [vercel.svg](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/icons/vercel.svg)   | Simple Icons, CC0 1.0 Universal |
| Notion  | [notion.svg](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/icons/notion.svg)   | Simple Icons, CC0 1.0 Universal |
| Linear  | [linear.svg](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/icons/linear.svg)   | Simple Icons, CC0 1.0 Universal |
| Todoist | [todoist.svg](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/icons/todoist.svg) | Simple Icons, CC0 1.0 Universal |

## Display adaptations

- Brand geometry is embedded as React SVG elements; SVG source titles, exported
  IDs, and stylesheet wrappers are omitted. GitLab's original CSS fill values
  become equivalent per-path `fill` attributes. Slack's redundant artboard clip
  is omitted; the SVG viewport provides the same boundary.
- Figma and GitLab retain their official full-color artwork. Their export
  artboard whitespace is cropped with a centered viewBox while preserving all
  path geometry and proportions. Slack retains the original 54 × 54 viewBox and
  current official colors. Airtable retains its original viewBox and black/white
  treatment.
- GitHub, Notion, Vercel, and Airtable use the application's `text-foreground`
  theme token. Sentry uses its published `#362D59` in light mode and the foreground
  token in dark mode. Linear uses published `#5E6AD2`, with a `#9DA7FF` display tint
  in dark mode for contrast. Todoist uses published `#E44332` in both themes.
- Each icon is decorative (`aria-hidden`, non-focusable), sized with the caller's
  `className`, and paired with the calling control's accessible service label.
  Unknown providers use the existing `lucide-react` Cable mark in currentColor.

## Frozen source checksums

| File           | SHA-256                                                            |
| -------------- | ------------------------------------------------------------------ |
| `airtable.svg` | `b0c1aed38ce90a781cbe56a91317b59782e33b1859823c72d9942d7ba0107475` |
| `figma.svg`    | `9798b710e015c7f3fa6101779e323568d6a5a022651d427021262ce850467b07` |
| `github.svg`   | `3bf8cceead820aec50d4ee825a3fd02c5a1cd6665cc9cf4cbf3d9c8861a204bb` |
| `gitlab.svg`   | `d8522f9bb83b35bcf0ab6e7fc25a312c26120028af308bec1dd9d20e15c1a615` |
| `linear.svg`   | `90b91b61090f4f9c94f9cb24769642278f03e8eedcfe5680738cf3a186bfc00f` |
| `notion.svg`   | `b17d2a2b592a06252efef522d5205f0c7a958f748d40df1011ed081417e42f85` |
| `sentry.svg`   | `8ba32902ffbac503784607374f57df5e3cbcf57a99d0adff03e735575500adc6` |
| `slack.svg`    | `1f40066b694020057218c46eb2a11982b278d89b2dc8f96a21e4ea04e2b9db3b` |
| `todoist.svg`  | `112b8e04327007cf75839bee7547718f334908c27700f9d5f5211062258510fe` |
| `vercel.svg`   | `57f1e4135486c566e9878fddd259f7f6bf8ec43f31e7e6e38a36d9e814a1c0e0` |
