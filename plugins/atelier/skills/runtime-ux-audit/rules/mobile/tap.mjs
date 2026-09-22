/**
 * Mobile rule measured in Chromium: tap target size (WCAG 2.2 SC 2.5.8).
 */
const CIRCLE = 24; // SC 2.5.8 spacing circle diameter, CSS px
const SLACK = 0.5; // sub-pixel rounding tolerance, CSS px

const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const contains = (a, b) => b.x >= a.x - SLACK && b.y >= a.y - SLACK
  && b.x + b.width <= a.x + a.width + SLACK && b.y + b.height <= a.y + a.height + SLACK;

/** Distance from point p to the nearest point of rect r (0 inside). */
function distanceToRect(p, r) {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

const round1 = (n) => Math.round(n * 10) / 10;

function describe(item) {
  const bits = [String(item.tag ?? 'element')];
  if (item.type) bits.push(`[type=${item.type}]`);
  if (item.role) bits.push(`[role=${item.role}]`);
  const text = String(item.text ?? '').replace(/\s+/g, ' ').trim();
  return text ? `${bits.join('')} "${text}"` : bits.join('');
}

/** Screen-reader-only and off-screen elements are not visible targets. */
function isRealTarget(item) {
  const r = item.rect;
  if (!r || !(r.width > 0) || !(r.height > 0)) return false;
  if (r.width <= 1 && r.height <= 1) return false;
  return r.x + r.width > 0 && r.y + r.height > 0;
}

const isNativeCheckable = (item) => String(item.tag).toLowerCase() === 'input' && /^(checkbox|radio)$/i.test(String(item.type ?? ''));

export const tapTargetUnderMinimum = {
  id: 'atelier/runtime-ux/tap-target-under-minimum',
  area: 'mobile',
  severity: 'serious',
  confidence: 'high',
  methods: ['dom'],
  phase: 'dynamic',
  brand: true,
  description: 'An interactive element is smaller than the minimum tap size (24px by WCAG 2.2 SC 2.5.8, or targets.minTapPx) and, at the default floor, too close to other targets.',
  helpUrl: 'https://www.w3.org/TR/WCAG22/#target-size-minimum',
  check(ctx) {
    const sweep = ctx.dynamic.sweep;
    if (!sweep || !Array.isArray(sweep.interactive)) return { notApplicable: 'no interactive sweep (probe did not run)' };
    const min = ctx.budgets.minTapPx;
    const targets = sweep.interactive.filter((i) => i && i.visible === true && i.disabled !== true && isRealTarget(i));
    const undersized = (i) => i.rect.width + SLACK < min || i.rect.height + SLACK < min;
    const underCircle = (i) => i.rect.width + SLACK < CIRCLE || i.rect.height + SLACK < CIRCLE;
    const spacing = ctx.budgets.minTapPxSource === 'default';

    const out = [];
    for (const item of targets) {
      if (item.inlineInText === true || isNativeCheckable(item) || !undersized(item)) continue;
      let overlaps = null;
      if (spacing) {
        const c = center(item.rect);
        for (const other of targets) {
          if (other === item || contains(item.rect, other.rect) || contains(other.rect, item.rect)) continue;
          const hitsRect = distanceToRect(c, other.rect) + SLACK < CIRCLE / 2;
          const oc = center(other.rect);
          const hitsCircle = underCircle(other) && Math.hypot(c.x - oc.x, c.y - oc.y) + SLACK < CIRCLE;
          if (hitsRect || hitsCircle) { overlaps = other.selector; break; }
        }
        // WCAG 2.5.8 spacing exception: a lone small target passes.
        if (overlaps === null) continue;
      }
      const w = round1(item.rect.width);
      const h = round1(item.rect.height);
      const data = { height: h, minTapPx: min, width: w };
      if (overlaps !== null) data.overlaps = String(overlaps);
      out.push({ node: ctx.ref.dynamic({ selector: String(item.selector), snippet: describe(item) }), message: `${w}x${h} px < ${min}`, data });
    }
    if (sweep.interactiveTruncated === true) {
      out.push({
        node: ctx.ref.dynamic({ selector: 'document', snippet: `${sweep.interactive.length} interactive elements measured` }),
        message: 'The sweep stopped at its element cap, so later targets were not measured.',
        incomplete: true,
      });
    }
    return out;
  },
};
