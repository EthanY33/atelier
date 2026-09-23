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

// Both indexes below are built once per node or script and hold only the
// comments that carry a marker (usually none), so checking a finding costs a
// few lookups instead of a scan over every comment of the sheet or script.

/** CSS node -> texts of the marked comments directly before it. */
const markedBeforeNode = new WeakMap();
function markedPrecedingComments(node) {
  let out = markedBeforeNode.get(node);
  if (out) return out;
  out = [];
  let prev = typeof node?.prev === 'function' ? node.prev() : undefined;
  while (prev && prev.type === 'comment') {
    if (MARK_RE.test(String(prev.text ?? ''))) out.push(prev.text);
    prev = prev.prev();
  }
  markedBeforeNode.set(node, out);
  return out;
}

/** Script record -> end line -> comments that carry a marker. */
const markedByScript = new WeakMap();
function markedCommentsByEndLine(script) {
  let byLine = markedByScript.get(script);
  if (byLine) return byLine;
  byLine = new Map();
  for (const c of script.comments ?? []) {
    const end = c.loc?.end?.line;
    if (!end || !MARK_RE.test(String(c.value ?? ''))) continue;
    const list = byLine.get(end);
    if (list) list.push(c);
    else byLine.set(end, [c]);
  }
  markedByScript.set(script, byLine);
  return byLine;
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
        if (markedPrecedingComments(n).some((t) => matches(t, ruleId))) return true;
      }
    }
    // JS: a comment ending on the same line or the line before.
    if (meta.script && meta.jsLine) {
      const byLine = markedCommentsByEndLine(meta.script);
      for (const line of [meta.jsLine, meta.jsLine - 1]) {
        for (const c of byLine.get(line) ?? []) if (matches(c.value, ruleId)) return true;
      }
    }
    return false;
  };
}
