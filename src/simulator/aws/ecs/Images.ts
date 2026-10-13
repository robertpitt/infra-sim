import type { Host } from "../../fleet/Hosts.ts"

/**
 * Which images each host (an ECS container instance, an EKS node) has, and when each will be there: a host pulls an image
 * once, and a task or pod placed on it later reuses it (ECS's cached images, Kubernetes' `imagePullPolicy: IfNotPresent`).
 * One placed while the image is still downloading waits for the rest of that download rather than starting another.
 */
export class ImageCache {
  private readonly hosts = new WeakMap<Host, Map<string, number>>()

  constructor(private readonly now: () => number) {}

  /**
   * How long the pull takes for a unit placed on `host` now, whose pull starts `startsIn` ms from now: the full pull the
   * first time (and note when the image will be there), the rest of a pull under way, or `cachedMs` once it is there.
   */
  pullMs(host: Host | undefined, image: string, fullMs: number, cachedMs: number, startsIn: number): number {
    if (host === undefined) return fullMs
    let images = this.hosts.get(host)
    if (images === undefined) this.hosts.set(host, (images = new Map()))
    const ready = images.get(image)
    if (ready !== undefined) return Math.max(cachedMs, ready - this.now() - startsIn)
    images.set(image, this.now() + startsIn + fullMs)
    return fullMs
  }

  /** Mark `image` as on every host that has tenants: what ran there before the simulation started. */
  seed(hosts: ReadonlyArray<Host>, image: string): void {
    for (const h of hosts) {
      if (h.tenants.size === 0) continue
      let images = this.hosts.get(h)
      if (images === undefined) this.hosts.set(h, (images = new Map()))
      images.set(image, 0)
    }
  }
}
