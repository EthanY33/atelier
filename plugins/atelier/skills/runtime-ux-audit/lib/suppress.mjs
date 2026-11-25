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

/**
 * The parsed id list of a comment that carries a marker, or null when it has
 * none.
 * @param {string} text
 * @returns {{ all: boolean, ids: Set<string> }|null}
 */
function parseMarker(text) {
  const m = MARK_RE.exec(String(text ?? ''));
  return m ? parseIgnoreIds(m[1].replace(/\*\/\s*$/, '')) : null;
}

const hits = (parsed, ruleId) => parsed.all || parsed.ids.has(ruleId);

// Both indexes below are built once per node or script and hold only the
// comments that carry a marker (usually none), each already parsed, so
// checking a finding costs a few lookups instead of a scan over every comment
// of the sheet or script, and a long id list is split once, not once per
// finding under it.

/** CSS node -> parsed id lists of the marked comments directly before it. */
const markedBeforeNode = new WeakMap();
function markedPrecedingComments(node) {
  let out = markedBeforeNode.get(node);
  if (out) return out;
  out = [];
  let prev = typeof node?.prev === 'function' ? node.prev() : undefined;
  while (prev && prev.type === 'comment') {
    const parsed = parseMarker(prev.text);
    if (parsed) out.push(parsed);
    prev = prev.prev();
  }
  markedBeforeNode.set(node, out);
  return out;
}

/** Script record -> end line -> parsed id lists of the comments that carry a marker. */
const markedByScript = new WeakMap();
function markedCommentsByEndLine(script) {
  let byLine = markedByScript.get(script);
  if (byLine) return byLine;
  byLine = new Map();
  for (const c of script.comments ?? []) {
    const end = c.loc?.end?.line;
    if (!end) continue;
    const parsed = parseMarker(c.value);
    if (!parsed) continue;
    const list = byLine.get(end);
    if (list) list.push(parsed);
    else byLine.set(end, [parsed]);
  }
  markedByScript.set(script, byLine);
  return byLine;
}

/**
 * Build a suppression predicate for one audit.
 * @returns {(ruleId: string, ref: object) => boolean}
 */
export function createSuppressor() {
  // Element -> its parsed data-atelier-ignore list. Parsed once per element:
  // a long list above many findings would otherwise be split again for each.
  const ignoreOf = new WeakMap();
  return (ruleId, ref) => {
    const meta = refMeta(ref);
    if (!meta) return false;
    // data-atelier-ignore on the anchor or an ancestor.
    const model = meta.model;
    const anchor = meta.anchorEl;
    if (anchor && model && model.owns(anchor)) {
      for (const el of [anchor, ...model.ancestors(anchor)]) {
        if (!model.hasAttr(el, 'data-atelier-ignore')) continue;
        let parsed = ignoreOf.get(el);
        if (!parsed) ignoreOf.set(el, (parsed = parseIgnoreIds(model.attr(el, 'data-atelier-ignore'))));
        if (parsed.all || parsed.ids.has(ruleId)) return true;
      }
    }
    // CSS: a comment right before the node or before any enclosing rule/at-rule.
    if (meta.cssNode) {
      for (let n = meta.cssNode; n && n.type !== 'root' && n.type !== 'document'; n = n.parent) {
        if (markedPrecedingComments(n).some((parsed) => hits(parsed, ruleId))) return true;
      }
    }
    // JS: a comment ending on the same line or the line before.
    if (meta.script && meta.jsLine) {
      const byLine = markedCommentsByEndLine(meta.script);
      for (const line of [meta.jsLine, meta.jsLine - 1]) {
        for (const parsed of byLine.get(line) ?? []) if (hits(parsed, ruleId)) return true;
      }
    }
    return false;
  };
}
