/**
 * panels rules that read the HTML (and, for tooltip focus calls, the JS).
 * Every rule here also re-runs on the rendered DOM under --dynamic.
 */
import { pathOf } from '../../lib/js-model.mjs';
import {
  backdropName, inDocumentOrder, isAriaModal, labelledByText, panelsRule, roleOf, stringValue, unwrapChain,
} from './shared.mjs';

const HELP = Object.freeze({
  dialogPattern: 'https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/',
  dialogElement: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog',
  tooltip: 'https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/',
  backdrop: 'https://developer.mozilla.org/en-US/docs/Web/CSS/::backdrop',
  closedby: 'https://html.spec.whatwg.org/multipage/interactive-elements.html#attr-dialog-closedby',
});

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

// ---------------------------------------------------------------------------
// Dialog names
// ---------------------------------------------------------------------------

const dialogMissingLabel = panelsRule('dialog-missing-label', {
  severity: 'serious',
  confidence: 'high',
  methods: ['html'],
  rendered: true,
  description: 'A <dialog> has no accessible name (aria-label, aria-labelledby or title), so screen readers announce it without a title.',
  helpUrl: HELP.dialogPattern,
  check(ctx) {
    const { html } = ctx;
    const dialogs = html.byTag('dialog');
    if (!dialogs.length) return { notApplicable: 'no <dialog> elements' };
    const out = [];
    for (const el of dialogs) {
      if (nonEmpty(html.attr(el, 'aria-label')) || nonEmpty(html.attr(el, 'title'))) continue;
      if (labelledByText(html, el) !== '') continue;
      const ids = (html.attr(el, 'aria-labelledby') ?? '').trim();
      out.push({
        node: ctx.ref.html(el),
        message: ids
          ? `aria-labelledby="${ids}" does not point at an element with text`
          : 'no aria-labelledby, aria-label or title; point aria-labelledby at the dialog heading',
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// role=dialog on a div
// ---------------------------------------------------------------------------

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

const divRoleDialog = panelsRule('div-role-dialog', {
  severity: 'moderate',
  confidence: 'medium',
  methods: ['html'],
  rendered: true,
  description: 'A modal built from a non-dialog element with role="dialog"; a native <dialog> opened with showModal() handles focus, inertness and Escape.',
  helpUrl: HELP.dialogElement,
  check(ctx) {
    const { html } = ctx;
    const els = inDocumentOrder(html, [...html.byRole('dialog'), ...html.byRole('alertdialog')])
      .filter((el) => html.tag(el) !== 'dialog');
    if (!els.length) return { notApplicable: 'no role="dialog" outside <dialog>' };
    const out = [];
    for (const el of els) {
      const parent = html.parent(el);
      const around = parent ? [parent, ...html.children(parent).filter((x) => x !== el)] : [];
      const backdrop = around.map((x) => backdropName(html, x)).find(Boolean) ?? null;
      const modal = isAriaModal(html, el);
      if (!modal && !backdrop) continue;
      const role = roleOf(html, el);
      out.push({
        node: ctx.ref.html(el, 'role'),
        message: modal
          ? `<${html.tag(el)} role="${role}" aria-modal="true">: use <dialog> with showModal()`
          : `<${html.tag(el)} role="${role}"> next to backdrop "${backdrop}": use <dialog> with showModal() and ::backdrop`,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Backdrop divs
// ---------------------------------------------------------------------------

const PAGE_TAGS = new Set(['html', 'head', 'body', 'main']);

function isModalContainer(html, el) {
  return html.tag(el) === 'dialog' || DIALOG_ROLES.has(roleOf(html, el)) || isAriaModal(html, el)
    || html.classes(el).includes('modal');
}

const backdropAsSiblingDiv = panelsRule('backdrop-as-sibling-div', {
  severity: 'moderate',
  confidence: 'medium',
  methods: ['html'],
  rendered: true,
  description: 'A hand-made backdrop element sits next to or around a modal; a modal <dialog> gets ::backdrop for free.',
  helpUrl: HELP.backdrop,
  check(ctx) {
    const { html } = ctx;
    const out = [];
    for (const el of html.elements) {
      const tag = html.tag(el);
      if (tag === 'dialog' || PAGE_TAGS.has(tag) || DIALOG_ROLES.has(roleOf(html, el))) continue;
      const name = backdropName(html, el);
      if (!name) continue;
      const parent = html.parent(el);
      const siblings = parent ? html.children(parent) : [];
      const at = siblings.indexOf(el);
      // Nearest following sibling first (backdrop, then modal), then preceding ones, then children.
      const candidates = [...siblings.slice(at + 1), ...siblings.slice(0, Math.max(at, 0)).reverse(), ...html.children(el)];
      const modal = candidates.find((x) => isModalContainer(html, x));
      if (!modal) continue;
      out.push({
        node: ctx.ref.html(el),
        message: `"${name}" backs modal ${html.cssPath(modal)}; style dialog::backdrop instead`,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// closedby="any" on destructive dialogs
// ---------------------------------------------------------------------------

const DESTRUCTIVE_RE = /\b(delete|remove|destroy)\b/i;

const destructiveDialogClosedbyAny = panelsRule('destructive-dialog-closedby-any', {
  severity: 'serious',
  confidence: 'medium',
  methods: ['html'],
  rendered: true,
  description: 'A destructive confirmation <dialog> uses closedby="any", so a stray click outside dismisses it.',
  helpUrl: HELP.closedby,
  check(ctx) {
    const { html } = ctx;
    const dialogs = html.byTag('dialog').filter((el) => (html.attr(el, 'closedby') ?? '').trim().toLowerCase() === 'any');
    if (!dialogs.length) return { notApplicable: 'no <dialog closedby="any">' };
    const out = [];
    for (const el of dialogs) {
      const text = [html.attr(el, 'aria-label') ?? '', labelledByText(html, el), html.text(el).slice(0, 300)].join(' ');
      const m = DESTRUCTIVE_RE.exec(text);
      if (!m) continue;
      out.push({
        node: ctx.ref.html(el, 'closedby'),
        message: `closedby="any" on a "${m[1].toLowerCase()}" confirmation; use closedby="closerequest" so only Escape or a button closes it`,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Focusable tooltips
// ---------------------------------------------------------------------------

/** Why a tooltip element can take focus: { attr, text } or null. */
function focusableReason(html, el) {
  const tabindex = html.attr(el, 'tabindex');
  if (tabindex !== null && /^\s*[+-]?\d+\s*$/.test(tabindex)) {
    const n = Number.parseInt(tabindex, 10);
    if (n >= 0) return { attr: 'tabindex', text: `tabindex="${tabindex.trim()}"` };
    return null;
  }
  const tag = html.tag(el);
  if (tag === 'button' || tag === 'select' || tag === 'textarea') return { attr: undefined, text: `native <${tag}>` };
  if (tag === 'a' && html.hasAttr(el, 'href')) return { attr: undefined, text: 'native <a href>' };
  if (tag === 'input' && (html.attr(el, 'type') ?? '').trim().toLowerCase() !== 'hidden') return { attr: undefined, text: 'native <input>' };
  const ce = html.attr(el, 'contenteditable');
  if (ce !== null && ce.trim().toLowerCase() !== 'false') return { attr: 'contenteditable', text: 'contenteditable' };
  return null;
}

const isTooltip = (html, el) => roleOf(html, el) === 'tooltip';

/** The tooltip a focus() call targets through getElementById/querySelector('<literal>'), or null. */
function focusedTooltip(ctx, call) {
  const { html, js } = ctx;
  const callee = unwrapChain(call.node.callee);
  if (callee?.type !== 'MemberExpression') return null;
  let recv = unwrapChain(callee.object);
  if (recv?.type === 'Identifier') recv = unwrapChain(js.initializerOf(call.script, recv.name));
  if (recv?.type !== 'CallExpression') return null;
  const path = pathOf(unwrapChain(recv.callee));
  const method = path.slice(path.lastIndexOf('.') + 1);
  const lit = stringValue(recv.arguments[0]);
  if (lit === null) return null;
  if (method === 'getElementById') {
    const el = html.byId(lit);
    return el && isTooltip(html, el) ? el : null;
  }
  if (method === 'querySelector') return html.querySelectorAll(lit).find((el) => isTooltip(html, el)) ?? null;
  return null;
}

const tooltipFocusable = panelsRule('tooltip-focusable', {
  severity: 'serious',
  confidence: 'high',
  methods: ['html', 'js'],
  rendered: true,
  description: 'A role="tooltip" element can take focus or receives focus from a script; tooltips must never be focused.',
  helpUrl: HELP.tooltip,
  check(ctx) {
    const { html, js } = ctx;
    const tips = html.byRole('tooltip');
    if (!tips.length) return { notApplicable: 'no role="tooltip" elements' };
    const out = [];
    for (const el of tips) {
      const why = focusableReason(html, el);
      if (!why) continue;
      out.push({ node: ctx.ref.html(el, why.attr), message: `role="tooltip" element is focusable (${why.text})` });
    }
    for (const call of js.callsByMethod('focus')) {
      const tip = focusedTooltip(ctx, call);
      if (!tip) continue;
      out.push({ node: ctx.ref.js(call), message: `focus() moves focus into role="tooltip" element ${html.cssPath(tip)}` });
    }
    return out;
  },
});

export const rules = [
  dialogMissingLabel,
  divRoleDialog,
  backdropAsSiblingDiv,
  destructiveDialogClosedbyAny,
  tooltipFocusable,
];
