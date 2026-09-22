/**
 * Mobile rules: viewport meta, viewport units, safe areas, the on-screen
 * keyboard, touch and wheel listeners, tap targets, hover reveals, scroll
 * containers and Home Screen icons. Each rule follows the contract checked by
 * validateRule in ../../lib/runner.mjs.
 */
import {
  carouselNoScrollSnap, fixedHeaderVhSized, hoverOnlyAffordance, modalNoOverscrollBehavior,
  usesVhWithoutDvh, webkitOverflowScrollingTouch,
} from './css.mjs';
import {
  doubleTapJsOverride, nonPassiveTouchListener, pushPermissionNoDisplayModeGuard, scrollHijack,
} from './js.mjs';
import { pwaNoAppleTouchIcon } from './pwa.mjs';
import { tapTargetUnderMinimum } from './tap.mjs';
import {
  envSafeAreaWithoutViewportFitCover, fixedBottomNoSafeArea, missingInteractiveWidget, userScalableNo,
  viewportMetaMissing,
} from './viewport.mjs';

export const rules = [
  usesVhWithoutDvh,
  fixedHeaderVhSized,
  envSafeAreaWithoutViewportFitCover,
  fixedBottomNoSafeArea,
  tapTargetUnderMinimum,
  nonPassiveTouchListener,
  scrollHijack,
  userScalableNo,
  viewportMetaMissing,
  carouselNoScrollSnap,
  modalNoOverscrollBehavior,
  pwaNoAppleTouchIcon,
  pushPermissionNoDisplayModeGuard,
  hoverOnlyAffordance,
  missingInteractiveWidget,
  webkitOverflowScrollingTouch,
  doubleTapJsOverride,
];
