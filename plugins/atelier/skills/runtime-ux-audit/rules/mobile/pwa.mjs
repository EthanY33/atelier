/**
 * Mobile rule for installable pages: the Home Screen icon iOS uses.
 */
const MIN_ICON = 180;
const TOUCH_ICON_RELS = ['apple-touch-icon', 'apple-touch-icon-precomposed'];

/** Largest square edge in a sizes value: 'any' is unbounded, '152x152 180x180' is 180, junk is null. */
export function largestIconSize(sizes) {
  let best = null;
  for (const tok of String(sizes ?? '').trim().toLowerCase().split(/\s+/)) {
    if (tok === 'any') return Number.POSITIVE_INFINITY;
    const m = /^(\d+)x(\d+)$/.exec(tok);
    if (m) best = Math.max(best ?? 0, Math.min(Number(m[1]), Number(m[2])));
  }
  return best;
}

function touchIconSize(link) {
  const fromAttr = largestIconSize(link.sizes);
  if (fromAttr !== null) return fromAttr;
  const img = link.imageSize;
  return img ? Math.min(img.width, img.height) : null;
}

export const pwaNoAppleTouchIcon = {
  id: 'atelier/runtime-ux/pwa-no-apple-touch-icon',
  area: 'mobile',
  severity: 'minor',
  confidence: 'medium',
  methods: ['html'],
  phase: 'static',
  description: 'An installable page has no apple-touch-icon and no manifest icon of at least 180x180, so iOS adds it to the Home Screen with a blurry or screenshot icon.',
  helpUrl: 'https://web.dev/articles/install-criteria',
  check(ctx) {
    if (!ctx.manifest) return { notApplicable: 'no web app manifest' };
    const manifestLink = ctx.html.links.find((l) => l.rel.includes('manifest'))?.el ?? null;
    const icons = ctx.html.links.filter((l) => TOUCH_ICON_RELS.some((r) => l.rel.includes(r)));
    const sizes = icons.map(touchIconSize);
    const known = sizes.filter((s) => s !== null);
    if (known.some((s) => s >= MIN_ICON)) return [];
    // Any touch icon of unknown size might be big enough: never flag it.
    if (icons.length && known.length < icons.length) return [];

    const json = ctx.manifest.json;
    const manifestIcons = json && typeof json === 'object' && Array.isArray(json.icons) ? json.icons : [];
    if (manifestIcons.some((i) => (largestIconSize(i?.sizes) ?? 0) >= MIN_ICON)) return [];
    const incomplete = json === null;
    const why = incomplete ? `the manifest could not be read (${ctx.manifest.error ?? 'unknown'})` : 'no manifest icon is 180x180 or larger';
    if (!icons.length) {
      return [{
        node: manifestLink ? ctx.ref.html(manifestLink) : ctx.ref.page('head', 'no apple-touch-icon'),
        message: `No <link rel="apple-touch-icon"> and ${why}; add a 180x180 PNG apple-touch-icon.`,
        incomplete,
      }];
    }
    // Every touch icon has a known size below 180 here.
    let best = 0;
    for (let i = 1; i < icons.length; i++) if (sizes[i] > sizes[best]) best = i;
    const largest = icons[best];
    const size = sizes[best];
    return [{
      node: ctx.ref.html(largest.el, largest.sizes !== null ? 'sizes' : 'href'),
      message: `The largest apple-touch-icon is ${size}x${size} and ${why}; iOS needs 180x180.`,
      data: { largestPx: size },
      incomplete,
    }];
  },
};
