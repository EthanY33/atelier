/**
 * inp rules: main-thread behavior that delays the next paint after input.
 * Each rule follows the contract in ../../lib/runner.mjs (validateRule).
 */
import { clickHandlerForcedLayout, mouseAndTouchPair, nonPassiveScrollListener, scrollListenerAnimatesTransform } from './listeners.mjs';
import { noSyncXhr, requestIdleCallbackNoTimeout, setTimeoutZeroAsYield } from './scheduling.mjs';
import { longtaskWithoutLoaf, missingWebVitalsOnInp } from './rum.mjs';
import { frameworkHydrationOnStaticPage } from './hydration.mjs';
import { inpEstimateOverBudget, loafLongScript, missingContentVisibility } from './dynamic.mjs';

export const rules = [
  nonPassiveScrollListener,
  setTimeoutZeroAsYield,
  clickHandlerForcedLayout,
  mouseAndTouchPair,
  requestIdleCallbackNoTimeout,
  missingContentVisibility,
  scrollListenerAnimatesTransform,
  frameworkHydrationOnStaticPage,
  missingWebVitalsOnInp,
  longtaskWithoutLoaf,
  inpEstimateOverBudget,
  loafLongScript,
  noSyncXhr,
];
