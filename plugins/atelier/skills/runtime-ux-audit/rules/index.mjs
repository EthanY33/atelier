/**
 * Rule registry: the frozen concatenation of the four area arrays.
 */
import { rules as transitions } from './transitions/index.mjs';
import { rules as inp } from './inp/index.mjs';
import { rules as panels } from './panels/index.mjs';
import { rules as mobile } from './mobile/index.mjs';

export const RULES = Object.freeze([...transitions, ...inp, ...panels, ...mobile]);
export const rules = RULES;
