/**
 * Suppression: the ignore option, data-atelier-ignore on the anchor element
 * or an ancestor, a preceding CSS comment "atelier-ignore <id>", and a JS
 * comment "atelier-ignore <id>" on the same or the previous line.
 *
 * An empty id list ("atelier-ignore" alone, or data-atelier-ignore="")
 * suppresses every rule at that spot.
 */
import { refMeta } from './context.mjs';
import { toFullRuleId } from './options.mjs';

const MARK_RE = /atelier-ignore\b([^\n]*)/;

/**
 * Parse the id list after an atelier-ignore marker. Stops at the first token
 * that is not a rule id, so "atelier-ignore foo -- reason" works.
 * @param {string} text
 * @returns {{ all: boolean, ids: Set<string> }}
 */
export function parseIgnoreIds(text) {
  const ids = new Set();
  for (const tok of String(text ?? '').trim().split(/[\s,]+/)) {
    if (!tok) continue;
    if (!/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(tok)) break;
    ids.add(toFullRuleId(tok));
  }
  return { all: ids.size === 0, ids };
}

function matches(text, ruleId) {
  const m = MARK_RE.exec(String(text ?? ''));
  if (!m) return false;
  const { all, ids } = parseIgnoreIds(m[1].replace(/\*\/\s*$/, ''));
  return all || ids.has(ruleId);
}

function precedingComments(node) {
  const out = [];
  let prev = typeof node?.prev === 'function' ? node.prev() : undefined;
  while (prev && prev.type === 'comment') {
    out.push(prev.text);
    prev = prev.prev();
  }
  return out;
}

/**
 * Build a suppression predicate for one audit.
 * @returns {(ruleId: string, ref: object) => boolean}
 */
export function createSuppressor() {
  return (ruleId, ref) => {
    const meta = refMeta(ref);
    if (!meta) return false;
    // data-atelier-ignore on the anchor or an ancestor.
    const model = meta.model;
    const anchor = meta.anchorEl;
    if (anchor && model && model.owns(anchor)) {
      for (const el of [anchor, ...model.ancestors(anchor)]) {
        if (!model.hasAttr(el, 'data-atelier-ignore')) continue;
        const { all, ids } = parseIgnoreIds(model.attr(el, 'data-atelier-ignore'));
        if (all || ids.has(ruleId)) return true;
      }
    }
    // CSS: a comment right before the node or before any enclosing rule/at-rule.
    if (meta.cssNode) {
      for (let n = meta.cssNode; n && n.type !== 'root' && n.type !== 'document'; n = n.parent) {
        if (precedingComments(n).some((t) => matches(t, ruleId))) return true;
      }
    }
    // JS: a comment ending on the same line or the line before.
    if (meta.script && meta.jsLine) {
      for (const c of meta.script.comments ?? []) {
        const end = c.loc?.end?.line;
        if ((end === meta.jsLine || end === meta.jsLine - 1) && matches(c.value, ruleId)) return true;
      }
    }
    return false;
  };
}
