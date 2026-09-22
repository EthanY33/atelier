/**
 * panels rules: z-index budgets, dialog and popover semantics, panel motion
 * and compositor costs. Each rule follows the contract in
 * ../../lib/runner.mjs (validateRule).
 */
import { rules as cssRules } from './css.mjs';
import { rules as htmlRules } from './html.mjs';
import { rules as jsRules } from './js.mjs';
import { rules as dynamicRules } from './dynamic.mjs';

export const rules = [...cssRules, ...htmlRules, ...jsRules, ...dynamicRules];
