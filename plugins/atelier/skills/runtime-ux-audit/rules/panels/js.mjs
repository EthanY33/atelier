/**
 * panels rules that read the JS (with HTML evidence where the pattern needs it).
 */
import { boolLiteral } from '../../lib/css-values.mjs';
import { traverse } from '../../lib/js-model.mjs';
import { inDocumentOrder, panelsRule, roleOf, stringValue } from './shared.mjs';

const HELP = Object.freeze({
  dialogElement: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog',
  popover: 'https://developer.mozilla.org/en-US/docs/Web/API/Popover_API',
  menubar: 'https://www.w3.org/WAI/ARIA/apg/patterns/menubar/',
  inert: 'https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert',
});

const AUTO_POPOVER_VALUES = new Set(['', 'auto', 'hint']);

/** Elements whose popover attribute is auto or hint ('' means auto). */
function autoPopovers(html) {
  return html.withAttr('popover').filter((el) => AUTO_POPOVER_VALUES.has((html.attr(el, 'popover') ?? '').toLowerCase()));
}

/** Some <dialog> is shown modally: a showModal() call or a command="show-modal" invoker. */
function hasModalOpener(ctx) {
  const { html, js } = ctx;
  return js.callsByMethod('showModal').length > 0
    || html.withAttr('command').some((el) => (html.attr(el, 'command') ?? '').trim().toLowerCase() === 'show-modal');
}

// ---------------------------------------------------------------------------
// Focus-trap libraries
// ---------------------------------------------------------------------------

const FOCUS_TRAP_IMPORT_RE = /(^|[/@])(focus-trap|focus-trap-react|react-focus-lock|focus-lock)(\/|@|\.|$)/;
const FOCUS_TRAP_SRC_RE = /focus-trap|focus-lock/i;

const focusTrapLibraryNearDialog = panelsRule('focus-trap-library-near-dialog', {
  severity: 'minor',
  confidence: 'high',
  methods: ['js', 'html'],
  description: 'A focus-trap library ships next to a native <dialog>; showModal() already keeps focus inside the dialog.',
  helpUrl: HELP.dialogElement,
  check(ctx) {
    const { html, js } = ctx;
    const native = html.byTag('dialog').length > 0 || js.callsByMethod('showModal').length > 0;
    if (!native) return { notApplicable: 'no <dialog> element or showModal() call' };
    const out = [];
    for (const imp of js.imports) {
      if (!FOCUS_TRAP_IMPORT_RE.test(imp.source)) continue;
      out.push({ node: ctx.ref.js(imp), message: `${imp.kind} import of "${imp.source}" next to a native <dialog>` });
    }
    for (const el of html.byTag('script')) {
      const src = html.attr(el, 'src');
      if (!src || !FOCUS_TRAP_SRC_RE.test(src)) continue;
      out.push({ node: ctx.ref.html(el, 'src'), message: `loads ${src} next to a native <dialog>` });
    }
    for (const call of js.callsByMethod('createFocusTrap')) {
      out.push({ node: ctx.ref.js(call), message: 'createFocusTrap() next to a native <dialog>' });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Hand-made light dismiss
// ---------------------------------------------------------------------------

const OUTSIDE_EVENTS = new Set(['click', 'mousedown', 'pointerdown', 'pointerup', 'touchstart']);
const ROOT_TARGETS = new Set(['document', 'window', 'root-element']);
const OUTSIDE_TEST_RE = /\.contains\(|\.closest\(|composedPath\(/;
const POPOVER_WORD_RE = /hidePopover|togglePopover|popover/i;

const customOutsideClickOnAutoPopover = panelsRule('custom-outside-click-on-auto-popover', {
  severity: 'moderate',
  confidence: 'medium',
  methods: ['js', 'html'],
  description: 'A page-level click listener closes popovers by hand although popover="auto" already light-dismisses.',
  helpUrl: HELP.popover,
  check(ctx) {
    const { html, js } = ctx;
    if (!autoPopovers(html).length) return { notApplicable: 'no popover="auto" or "hint" elements' };
    const out = [];
    for (const l of js.listeners) {
      if (!ROOT_TARGETS.has(l.target) || !OUTSIDE_EVENTS.has(l.event) || !l.handler) continue;
      const src = l.handlerText;
      if (!OUTSIDE_TEST_RE.test(src) || !POPOVER_WORD_RE.test(src)) continue;
      out.push({
        node: ctx.ref.js(l),
        message: `${l.targetText} ${l.event} listener dismisses popovers by hand; popover="auto" already closes on an outside click`,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Hand-made Escape
// ---------------------------------------------------------------------------

const ESCAPE_RE = /(["'`])Esc(?:ape)?\1|\b(?:keyCode|which)\s*[!=]==?\s*27\b|\b27\s*[!=]==?\s*[\w$.]*\b(?:keyCode|which)\b/;
const CASE_27_RE = /\bcase\s+27\s*:/;
const KEYCODE_RE = /\b(?:keyCode|which)\b/;

function testsEscape(src) {
  return ESCAPE_RE.test(src) || (CASE_27_RE.test(src) && KEYCODE_RE.test(src));
}

const customEscapeOnDialogPopover = panelsRule('custom-escape-on-dialog-popover', {
  severity: 'minor',
  confidence: 'low',
  methods: ['js', 'html'],
  description: 'A keydown Escape handler closes modal dialogs or auto popovers, which already close on Escape.',
  helpUrl: HELP.popover,
  check(ctx) {
    const { html, js } = ctx;
    const popovers = html.withAttr('popover');
    const dialogs = html.byTag('dialog');
    const modalOpener = hasModalOpener(ctx);
    if (!popovers.length && !dialogs.length && !modalOpener) return { notApplicable: 'no dialog or popover' };
    // A dialog shown with show() or the open attribute is not modal: Escape does nothing there.
    const nonModal = js.callsByMethod('show').length > 0 || dialogs.some((d) => html.hasAttr(d, 'open'));
    const allModal = modalOpener && !nonModal;
    const allAuto = popovers.length > 0 && autoPopovers(html).length === popovers.length;
    const out = [];
    for (const l of js.listeners) {
      if (l.event !== 'keydown' && l.event !== 'keyup') continue;
      const src = l.handlerText ?? '';
      if (!testsEscape(src)) continue;
      if (allModal && /\.close\s*\(/.test(src)) {
        out.push({ node: ctx.ref.js(l), message: 'Escape handler calls close() although every dialog opens with showModal(), which closes on Escape by itself' });
      } else if (allAuto && /\.(?:hidePopover|togglePopover)\s*\(/.test(src)) {
        out.push({ node: ctx.ref.js(l), message: 'Escape handler hides a popover although every popover is auto or hint, which closes on Escape by itself' });
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Menus without arrow keys
// ---------------------------------------------------------------------------

const ARROW_RE = /Arrow(?:Down|Up)|["'`]Arrow|\b(?:keyCode|which)\s*===?\s*(?:38|40)\b|\bcase\s+(?:38|40)\s*:/;
/** Skip reasons that hide script the audit could not read (duplicates are already read). */
const UNREAD_SCRIPT_REASONS = new Set(['cross-origin', 'scheme-not-allowed', 'redirect-cross-origin', 'bare-specifier']);
/**
 * A script loads code the static pass never sees: it creates <script>
 * elements (loader snippets pass 'script' in as an argument, so a
 * createElement call in a script that also holds the string 'script' counts)
 * or imports a computed specifier.
 */
function injectsScripts(js) {
  const scriptWord = new Set([...js.stringLiterals('script'), ...js.stringLiterals('SCRIPT')].map((l) => l.script));
  for (const c of js.callsByMethod('createElement')) {
    const tag = stringValue(c.args[0]);
    if (tag !== null ? tag.toLowerCase() === 'script' : scriptWord.has(c.script)) return true;
  }
  let computed = false;
  for (const s of js.scripts) {
    if (!s.ast || computed) continue;
    traverse(s.ast, (n) => {
      if (computed) return false;
      if (n.type === 'ImportExpression' && stringValue(n.source) === null) computed = true;
      return !computed;
    });
  }
  return computed;
}

const menuNoArrowKeys = panelsRule('menu-no-arrow-keys', {
  severity: 'serious',
  confidence: 'medium',
  methods: ['js', 'html'],
  rendered: true,
  description: 'role="menu" or "menubar" promises arrow-key navigation, but no script handles ArrowUp or ArrowDown.',
  helpUrl: HELP.menubar,
  check(ctx) {
    const { html, js } = ctx;
    const menus = inDocumentOrder(html, [...html.byRole('menu'), ...html.byRole('menubar')]);
    if (!menus.length) return { notApplicable: 'no role="menu" or "menubar"' };
    const listenerHandles = js.listeners.some((l) => (l.event === 'keydown' || l.event === 'keyup')
      && ARROW_RE.test(l.handler ? l.handlerText : (l.script.source ?? '')));
    // A handler may live in another module or behind framework delegation:
    // any script that tests the arrow keys counts.
    if (listenerHandles || js.mentions(ARROW_RE)) return [];
    const unread = ctx.resources.filter((r) => (r.kind === 'script' || r.kind === 'module')
      && r.status === 'skipped' && UNREAD_SCRIPT_REASONS.has(r.reason));
    const injected = injectsScripts(js);
    const partial = !js.complete || unread.length > 0 || injected;
    let note = '';
    if (!js.complete) note = ' (some same-origin scripts could not be read)';
    else if (unread.length) note = ` (${unread.length} script${unread.length === 1 ? ' was' : 's were'} not read: ${unread[0].reason})`;
    else if (injected) note = ' (a script loads more scripts at run time, which the static pass cannot read)';
    return menus.slice(0, 5).map((el) => ({
      node: ctx.ref.html(el, 'role'),
      message: `role="${roleOf(html, el)}" but no keydown handler for ArrowUp/ArrowDown${note}`,
      incomplete: partial,
    }));
  },
});

// ---------------------------------------------------------------------------
// inert next to showModal()
// ---------------------------------------------------------------------------

const inertWithShowmodal = panelsRule('inert-with-showmodal', {
  severity: 'minor',
  confidence: 'medium',
  methods: ['js'],
  description: 'Code that calls showModal() also sets inert by hand; a modal dialog already makes the rest of the page inert.',
  helpUrl: HELP.inert,
  check(ctx) {
    const { js } = ctx;
    const opens = js.callsByMethod('showModal');
    if (!opens.length) return { notApplicable: 'no showModal() call' };
    const scopeOf = (info) => js.enclosingFunctions(info.ancestors)[0] ?? info.script.ast;
    const inertScopes = new Set();
    for (const a of js.assignments) {
      if (a.property === 'inert' && a.operator === '=' && boolLiteral(a.valueNode) === true) inertScopes.add(scopeOf(a));
    }
    for (const method of ['setAttribute', 'toggleAttribute']) {
      for (const c of js.callsByMethod(method)) {
        if (stringValue(c.args[0]) !== 'inert') continue;
        if (method === 'toggleAttribute' && boolLiteral(c.args[1]) === false) continue;
        inertScopes.add(scopeOf(c));
      }
    }
    return opens.filter((c) => inertScopes.has(scopeOf(c))).map((c) => ({
      node: ctx.ref.js(c),
      message: 'showModal() already makes the rest of the page inert; drop the manual inert toggle next to it',
    }));
  },
});

export const rules = [
  focusTrapLibraryNearDialog,
  customOutsideClickOnAutoPopover,
  customEscapeOnDialogPopover,
  menuNoArrowKeys,
  inertWithShowmodal,
];
