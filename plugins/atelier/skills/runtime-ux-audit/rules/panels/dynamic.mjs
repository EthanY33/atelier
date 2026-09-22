/**
 * panels rules that read the dynamic pass (DynamicFacts.dialogs).
 */
import { panelsRule } from './shared.mjs';

const LOST_FOCUS = new Set(['body', 'html']);

const focusLostAfterClose = panelsRule('focus-lost-after-close', {
  phase: 'dynamic',
  severity: 'serious',
  confidence: 'high',
  methods: ['trace'],
  description: 'After a dialog closed, focus fell to the page body instead of returning to the control that opened it.',
  helpUrl: 'https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/',
  check(ctx) {
    const dialogs = ctx.dynamic?.dialogs;
    if (!Array.isArray(dialogs)) return { notApplicable: 'the dialog focus probe did not run' };
    const opened = dialogs.filter((d) => d && d.opened === true);
    if (!opened.length) return { notApplicable: 'no dialog opened during the probe' };
    return opened
      .filter((d) => d.closed === true && (d.activeAfterClose === null || d.activeAfterClose === undefined || LOST_FOCUS.has(d.activeAfterClose)))
      .map((d) => ({
        node: ctx.ref.dynamic({
          selector: String(d.trigger ?? 'document'),
          snippet: `closed via ${d.closeMethod ?? 'unknown'}; focus on ${d.activeAfterClose ?? 'nothing'}`,
        }),
        message: 'focus did not return to the trigger after the dialog closed',
      }));
  },
});

export const rules = [focusLostAfterClose];
