/**
 * Dynamic-phase inp rules: they read DynamicFacts (ctx.dynamic) only.
 */
import { cmp, defineRule } from './shared.mjs';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ms = (v) => Math.round(num(v) ?? 0);

// ---------------------------------------------------------------------------
// inp-estimate-over-budget
// ---------------------------------------------------------------------------

export const inpEstimateOverBudget = defineRule({
  id: 'inp-estimate-over-budget',
  phase: 'dynamic',
  brand: true,
  severity: 'serious',
  confidence: 'medium',
  methods: ['trace'],
  description: 'The lab INP estimate (Event Timing, 4x CPU throttle, Pixel 7 profile) exceeds the INP budget from brand.json targets.inpBudgetMs or the 200 ms default.',
  helpUrl: 'https://web.dev/articles/inp',
  check(ctx) {
    const inp = ctx.dynamic?.interactions?.inp ?? null;
    if (!inp) return { notApplicable: 'no interaction data' };
    const est = num(inp.estimateMs);
    if (est === null) return inp.belowThreshold === true ? [] : { notApplicable: 'no interactions measured' };
    const budget = ctx.budgets.inpBudgetMs;
    if (!(est > budget)) return [];
    const w = inp.worst ?? null;
    const parts = w ? ` (input delay ${ms(w.inputDelayMs)}, processing ${ms(w.processingMs)}, presentation ${ms(w.presentationMs)})` : '';
    const source = ctx.budgets.inpBudgetMsSource === 'brand' ? 'brand.json targets.inpBudgetMs' : 'default';
    const data = { budgetMs: budget, estimateMs: ms(est), interactions: Number.isInteger(inp.count) ? inp.count : 0 };
    if (w) Object.assign(data, { inputDelayMs: ms(w.inputDelayMs), processingMs: ms(w.processingMs), presentationMs: ms(w.presentationMs) });
    let hint = '';
    if (w) {
      const [biggest] = [['input delay', ms(w.inputDelayMs)], ['processing', ms(w.processingMs)], ['presentation', ms(w.presentationMs)]].sort((a, b) => b[1] - a[1]);
      hint = biggest[0] === 'processing' ? ' Most of it is handler time: split the work and yield.'
        : biggest[0] === 'input delay' ? ' Most of it is input delay: other tasks were running; break up long tasks.'
          : ' Most of it is presentation: reduce style, layout and paint work after the handler.';
    }
    return [{
      node: ctx.ref.dynamic({
        selector: (w && typeof w.target === 'string' && w.target) || 'document',
        snippet: `${w?.name ? `${w.name} ` : ''}${ms(est)} ms${parts}`,
      }),
      message: `INP estimate ${ms(est)} ms exceeds the ${budget} ms budget (${source}).${hint}`,
      data,
    }];
  },
});

// ---------------------------------------------------------------------------
// loaf-long-script
// ---------------------------------------------------------------------------

export const loafLongScript = defineRule({
  id: 'loaf-long-script',
  phase: 'dynamic',
  severity: 'serious',
  confidence: 'high',
  methods: ['trace'],
  description: 'A script ran longer than 100 ms inside one long animation frame during the interaction probe, blocking input and rendering.',
  helpUrl: 'https://developer.chrome.com/docs/web-platform/long-animation-frames',
  check(ctx) {
    const loaf = ctx.dynamic?.interactions?.loaf;
    if (!Array.isArray(loaf)) return { notApplicable: 'long-animation-frame data unavailable' };
    const limit = ctx.budgets.longScriptMs;
    const best = new Map();
    for (const frame of loaf) {
      for (const s of frame?.scripts ?? []) {
        const d = num(s?.durationMs);
        if (d === null || !(d > limit)) continue;
        const key = `${s.sourceURL ?? ''}|${s.sourceFunctionName ?? ''}|${s.invoker ?? ''}`;
        const prev = best.get(key);
        if (!prev || d > prev.d) best.set(key, { key, d, s });
      }
    }
    const list = [...best.values()].sort((a, b) => (b.d - a.d) || cmp(a.key, b.key));
    return list.map(({ d, s }) => {
      const url = typeof s.sourceURL === 'string' ? s.sourceURL : '';
      const invoker = typeof s.invoker === 'string' && s.invoker ? s.invoker : '(unknown invoker)';
      const pos = url && num(s.sourceCharPosition) !== null && s.sourceCharPosition >= 0 ? ctx.js.locate(url, s.sourceCharPosition) : null;
      const forced = ms(s.forcedStyleAndLayoutDurationMs);
      const fn = typeof s.sourceFunctionName === 'string' && s.sourceFunctionName ? s.sourceFunctionName : null;
      const data = { durationMs: ms(d), forcedStyleAndLayoutMs: forced, invoker };
      if (typeof s.invokerType === 'string' && s.invokerType) data.invokerType = s.invokerType;
      if (fn) data.sourceFunctionName = fn;
      return {
        node: ctx.ref.dynamic({
          selector: url || invoker,
          snippet: `${invoker} ${ms(d)} ms (forced style/layout ${forced} ms)`,
          location: pos ? `${url}:${pos.line}:${pos.column}` : url || '(runtime)',
        }),
        message: `${fn ? `${fn}() ` : 'Script '}ran ${ms(d)} ms in one frame during the interaction probe (limit ${limit} ms); split it and yield to the main thread.`,
        data,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// missing-content-visibility
// ---------------------------------------------------------------------------

const MIN_ITEMS = 20;

export const missingContentVisibility = defineRule({
  id: 'missing-content-visibility',
  phase: 'dynamic',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['dom'],
  description: 'A long list of repeated blocks sits mostly below the fold without content-visibility: auto, so every item pays style and layout cost up front.',
  helpUrl: 'https://web.dev/articles/content-visibility',
  check(ctx) {
    const sweep = ctx.dynamic?.sweep ?? null;
    if (!sweep || !Array.isArray(sweep.repeatedGroups)) return { notApplicable: 'no DOM sweep' };
    return sweep.repeatedGroups
      .filter((g) => num(g?.count) >= MIN_ITEMS && num(g?.belowFoldCount) >= MIN_ITEMS && g.contentVisibility === false)
      .map((g) => ({
        node: ctx.ref.dynamic({ selector: String(g.parentSelector ?? 'document'), snippet: `${g.count} x ${g.signature}` }),
        message: `${g.belowFoldCount} of ${g.count} ${g.signature} items start more than two viewports down; add content-visibility: auto with contain-intrinsic-size to skip their rendering.`,
        data: { belowFoldCount: g.belowFoldCount, count: g.count, signature: String(g.signature ?? '') },
      }));
  },
});
