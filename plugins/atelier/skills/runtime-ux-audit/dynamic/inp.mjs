/**
 * INP estimate from Event Timing entries (pure; no browser).
 *
 * Mirrors the web-vitals selection without the dependency: entries are grouped
 * by interactionId, an interaction's latency is the longest entry in its group,
 * and the estimate skips one outlier per 50 interactions.
 */

const round = (n) => Math.round(n);

/**
 * @param {Array<{ interactionId: number, name: string, target: string|null, startTime: number, duration: number, processingStart: number, processingEnd: number }>} entries
 * @param {number|null} [interactionCount] - performance.interactionCount (Chromium), or null
 * @param {{ attempted?: number }} [opts] - attempted: interactions the probe performed
 * @returns {{ estimateMs: number|null, p75InteractionMs: number|null, maxMs: number|null, count: number, belowThreshold: boolean,
 *   worst: { name: string, target: string|null, inputDelayMs: number, processingMs: number, presentationMs: number }|null }}
 */
export function summarizeInteractions(entries, interactionCount = null, { attempted = 0 } = {}) {
  const groups = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const id = e.interactionId;
    if (typeof id !== 'number' || !Number.isFinite(id) || id === 0) continue;
    if (typeof e.duration !== 'number' || !Number.isFinite(e.duration)) continue;
    const g = groups.get(id);
    if (!g) groups.set(id, { id, latency: e.duration, longest: e });
    else if (e.duration > g.latency) {
      g.latency = e.duration;
      g.longest = e;
    }
  }

  // Longest first; ties by interactionId so the result does not depend on input order.
  const list = [...groups.values()].sort((a, b) => b.latency - a.latency || a.id - b.id);
  const count = list.length;
  const countValid = typeof interactionCount === 'number' && Number.isFinite(interactionCount) && interactionCount >= 0;
  if (count === 0) {
    return {
      estimateMs: null,
      p75InteractionMs: null,
      maxMs: null,
      count: 0,
      belowThreshold: attempted > 0 || (countValid && interactionCount > 0),
      worst: null,
    };
  }

  const n = countValid ? interactionCount : count;
  const estimate = list[Math.min(Math.floor(n / 50), count - 1)].latency;
  const ascending = list.map((g) => g.latency).sort((a, b) => a - b);
  const p75 = ascending[Math.ceil(0.75 * count) - 1];

  const w = list[0].longest;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const start = num(w.startTime);
  const ps = num(w.processingStart);
  const pe = num(w.processingEnd);
  const part = (a, b) => (a === null || b === null ? 0 : Math.max(0, round(b - a)));

  return {
    estimateMs: round(estimate),
    p75InteractionMs: round(p75),
    maxMs: round(list[0].latency),
    count,
    belowThreshold: false,
    worst: {
      name: typeof w.name === 'string' ? w.name : '',
      target: typeof w.target === 'string' ? w.target : null,
      inputDelayMs: part(start, ps),
      processingMs: part(ps, pe),
      presentationMs: start === null || pe === null ? 0 : Math.max(0, round(start + w.duration - pe)),
    },
  };
}
