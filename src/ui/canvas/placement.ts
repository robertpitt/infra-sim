import type { ComponentManifest, Doc } from "../state/types.ts"
import { NODE_W, nodeHeight, type Point } from "./geometry.ts"

const MARGIN = 28

/**
 * The nearest spot to `wanted` where a new node of this type won't sit on top of an existing one.
 * Used when adding by click, so repeated clicks fan out instead of stacking.
 */
export const freeSpot = (design: Doc, byType: Readonly<Record<string, ComponentManifest>>, type: string, wanted: Point): Point => {
  const w = NODE_W
  const h = nodeHeight(byType[type])
  const rects = Object.values(design.nodes).filter((n) => byType[n.type]?.container === undefined).map((n) => ({
    x: n.position?.x ?? 0,
    y: n.position?.y ?? 0,
    w: NODE_W,
    h: nodeHeight(byType[n.type])
  }))
  const clear = (x: number, y: number) =>
    !rects.some((r) => x < r.x + r.w + MARGIN && x + w + MARGIN > r.x && y < r.y + r.h + MARGIN && y + h + MARGIN > r.y)
  if (clear(wanted.x, wanted.y)) return wanted

  const stepX = w + MARGIN * 2
  const stepY = h + MARGIN
  const candidates: Array<Point> = []
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) candidates.push({ x: wanted.x + dx * stepX, y: wanted.y + dy * stepY })
  }
  // Nearest first, preferring to go right of the existing flow over left.
  candidates.sort((a, b) => Math.hypot(a.x - wanted.x, (a.y - wanted.y) * 1.6) - Math.hypot(b.x - wanted.x, (b.y - wanted.y) * 1.6) || b.x - a.x)
  return candidates.find((c) => clear(c.x, c.y)) ?? wanted
}
