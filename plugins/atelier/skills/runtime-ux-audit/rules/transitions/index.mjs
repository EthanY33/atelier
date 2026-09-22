/**
 * transitions rules: bfcache blockers, View Transition API gaps, Speculation
 * Rules problems and prerender-unsafe analytics.
 * Each rule follows the contract in ../../lib/runner.mjs (validateRule).
 */
import { rules as bfcache } from './bfcache.mjs';
import { rules as viewTransitions } from './view-transitions.mjs';
import { rules as speculation } from './speculation.mjs';
import { rules as analytics } from './analytics.mjs';

export const rules = [...bfcache, ...viewTransitions, ...speculation, ...analytics];
