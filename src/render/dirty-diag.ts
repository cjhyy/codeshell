/**
 * dirty-diag — frame-scoped diagnostic accumulator for "why did this
 * frame re-render?" investigations.
 *
 * Enabled only when `CODESHELL_DEBUG_DIRTY=1`. Otherwise every entry
 * point is an inlined no-op so production renders pay zero cost.
 *
 * Flow:
 *   renderer.ts: beginFrame()    // clear accumulator
 *   renderChildren: noteDirty()  // called for every dirty child
 *   renderer.ts: endFrame()      // emit a single log line with the
 *                                // top dirty sources
 *
 * Pattern matches the existing `[ink] High write ratio: ...` debug
 * line (output.ts:525) — same `logForDebugging` channel, same
 * structured fields, so the user can grep both in one bucket.
 */

import type { DOMElement } from './dom.js'
import { logForDebugging } from '../utils/debug.js'

const ENABLED = process.env.CODESHELL_DEBUG_DIRTY === '1'

interface DirtySource {
  /** Yoga-reported node name (ink-box, ink-text, ...). */
  name: string
  /** Computed width × height after layout. */
  w: number
  h: number
  /** Computed top relative to parent (for spotting spacer shifts). */
  top: number
  /** Does this child shield its dirty via clipsBothAxes? */
  clipped: boolean
  /** First few characters of the first descendant Text — gives the
   *  reader something to grep by ("verb…", "deepseek-v4-pro", etc.). */
  textPreview: string
}

let collected: DirtySource[] = []
let totalDirty = 0

/** Reset the accumulator at the start of a frame. */
export function beginFrame(): void {
  if (!ENABLED) return
  collected = []
  totalDirty = 0
}

/**
 * Record one dirty child. Capped at TOP_K entries to keep emit cost
 * bounded; total count still increments so the log shows the full
 * frame's dirty cardinality.
 */
const TOP_K = 8

export function noteDirty(child: DOMElement, clipped: boolean): void {
  if (!ENABLED) return
  totalDirty += 1
  if (collected.length >= TOP_K) return

  const yoga = child.yogaNode
  const w = yoga?.getComputedWidth() ?? 0
  const h = yoga?.getComputedHeight() ?? 0
  const top = yoga?.getComputedTop() ?? 0
  collected.push({
    name: (child as { nodeName?: string }).nodeName ?? '?',
    w: Math.round(w),
    h: Math.round(h),
    top: Math.round(top),
    clipped,
    textPreview: firstTextPreview(child),
  })
}

/** Emit the line and reset. Called once per frame after the render. */
export function endFrame(): void {
  if (!ENABLED) return
  if (totalDirty === 0) return
  const summary = collected
    .map(
      (d) =>
        `${d.name}${d.clipped ? '*' : ''} ${d.w}x${d.h}@${d.top} "${d.textPreview}"`,
    )
    .join(' | ')
  // Marker `*` after name means the node is clipsBothAxes — its dirty
  // is shielded and does NOT poison sibling blits. Nodes WITHOUT `*`
  // that appear here are the actual blit-killers: each one cancels
  // prevScreen for every later sibling in render order.
  logForDebugging(
    `[ink-dirty] count=${totalDirty} top=${collected.length}: ${summary}`,
  )
}

/** Walk the subtree until the first Text node, return up to 24 chars. */
function firstTextPreview(node: DOMElement): string {
  type AnyNode = {
    nodeName?: string
    nodeValue?: string
    childNodes?: AnyNode[]
  }
  const stack: AnyNode[] = [node as unknown as AnyNode]
  while (stack.length > 0) {
    const n = stack.pop()!
    if (n.nodeName === '#text' && typeof n.nodeValue === 'string') {
      const cleaned = n.nodeValue.replace(/\s+/g, ' ').trim().slice(0, 24)
      if (cleaned.length > 0) return cleaned
    }
    const kids = n.childNodes
    if (kids && kids.length > 0) {
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
    }
  }
  return ''
}
