/**
 * framework-hydration-on-static-page: a hydration runtime ships with a page
 * whose server HTML has nothing to interact with.
 */
import { boolLiteral, calleePath, defineRule, traverse } from './shared.mjs';

const INTERACTIVE_ROLES = new Set(['button', 'tab', 'switch', 'checkbox', 'slider', 'combobox', 'menuitem', 'textbox']);
const ALWAYS_INTERACTIVE = new Set(['button', 'select', 'textarea', 'details', 'dialog', 'form']);
const NUXT_GLOBAL_RE = /(?:^|\.)__NUXT__$/;
const BUNDLE_SRC_RE = /\/_next\/static\/|\/_nuxt\//;
const HYDRATE_CALLS = [
  { re: /(?:^|\.)hydrateRoot$/, label: 'hydrateRoot()' },
  { re: /^ReactDOM\.hydrate$/, label: 'ReactDOM.hydrate()' },
  { re: /(?:^|\.)createSSRApp$/, label: 'createSSRApp()' },
];

function isInteractive(html, el) {
  const tag = html.tag(el);
  if (ALWAYS_INTERACTIVE.has(tag)) return true;
  if (tag === 'input') return (html.attr(el, 'type') ?? '').trim().toLowerCase() !== 'hidden';
  if ((tag === 'video' || tag === 'audio') && html.hasAttr(el, 'controls')) return true;
  const editable = html.attr(el, 'contenteditable');
  if (editable !== null && editable.trim().toLowerCase() !== 'false') return true;
  const tabindex = html.attr(el, 'tabindex');
  if (tabindex !== null && /^\s*[+-]?\d+\s*$/.test(tabindex) && Number.parseInt(tabindex, 10) >= 0) return true;
  const role = (html.attr(el, 'role') ?? '').trim().split(/\s+/)[0].toLowerCase();
  return INTERACTIVE_ROLES.has(role);
}

/** Interactive elements in <body> (links alone do not count). */
function countInteractive(html) {
  const body = html.byTag('body')[0];
  if (!body) return 0;
  const inBody = [body, ...html.descendants(body)];
  const set = new Set(inBody);
  let n = inBody.filter((el) => isInteractive(html, el)).length;
  n += html.eventAttrs.filter((a) => set.has(a.el)).length;
  return n;
}

/** First hydration evidence, in the documented order, as { node, label }. */
function findEvidence(ctx) {
  const { html, js } = ctx;
  for (const id of ['__NEXT_DATA__', '__NUXT_DATA__']) {
    const el = html.byId(id);
    if (el && html.tag(el) === 'script') return { node: ctx.ref.html(el, 'id'), label: `script#${id}`, framework: id === '__NEXT_DATA__' ? 'Next.js' : 'Nuxt' };
  }
  // Nuxt writes its state to window.__NUXT__; code that only reads it (for
  // example framework detection in an SDK) is not evidence.
  const nuxt = js.assignments.find((a) => NUXT_GLOBAL_RE.test(a.normalizedTarget));
  if (nuxt) return { node: ctx.ref.js(nuxt), label: '__NUXT__', framework: 'Nuxt' };
  const ssr = html.withAttr('data-server-rendered').find((el) => (html.attr(el, 'data-server-rendered') ?? '').trim().toLowerCase() === 'true');
  if (ssr) return { node: ctx.ref.html(ssr, 'data-server-rendered'), label: '[data-server-rendered=true]', framework: 'Vue' };
  for (const el of html.byTag('script')) {
    const src = html.attr(el, 'src');
    if (src !== null && BUNDLE_SRC_RE.test(src)) {
      return { node: ctx.ref.html(el, 'src'), label: `script[src*="${/_next\//.test(src) ? '/_next/static/' : '/_nuxt/'}"]`, framework: /_next\//.test(src) ? 'Next.js' : 'Nuxt' };
    }
  }
  for (const call of js.calls) {
    if (call.isNew) continue;
    const path = calleePath(call.node.callee);
    const hit = HYDRATE_CALLS.find((h) => h.re.test(path));
    if (hit) return { node: ctx.ref.js(call), label: hit.label, framework: hit.label === 'createSSRApp()' ? 'Vue' : 'React' };
  }
  // Svelte 3/4 style component options: new App({ target, hydrate: true }).
  for (const script of js.scripts) {
    if (!script.ast) continue;
    let prop = null;
    traverse(script.ast, (node) => {
      if (prop) return false;
      if (node.type === 'Property' && !node.computed && boolLiteral(node.value) === true
        && ((node.key.type === 'Identifier' && node.key.name === 'hydrate') || (node.key.type === 'Literal' && node.key.value === 'hydrate'))) prop = node;
      return true;
    });
    if (prop) return { node: ctx.ref.js(script, prop), label: 'hydrate: true', framework: 'Component' };
  }
  return null;
}

export const frameworkHydrationOnStaticPage = defineRule({
  id: 'framework-hydration-on-static-page',
  severity: 'moderate',
  confidence: 'low',
  methods: ['html', 'js'],
  description: 'A framework hydration runtime ships with a page whose server-rendered body has no interactive elements, spending main-thread time for nothing.',
  helpUrl: 'https://qwik.dev/docs/concepts/resumable/',
  check(ctx) {
    if (ctx.html.byTag('astro-island').length) return { notApplicable: 'islands hydrate selectively' };
    const ev = findEvidence(ctx);
    if (!ev) return { notApplicable: 'no hydration runtime' };
    if (countInteractive(ctx.html) > 0) return [];
    return [{
      node: ev.node,
      message: `${ev.framework} hydration (${ev.label}) runs on a page with no interactive elements; ship static HTML, or hydrate only the widgets that need it.`,
      data: { evidence: ev.label, framework: ev.framework, interactive: 0 },
    }];
  },
});
