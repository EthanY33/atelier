# Runtime UX audit

URL: index.html
Timestamp: 2026-01-01T00:00:00.000Z
Mode: static
Total violations: 23 rules, 28 instances (critical: 0, serious: 5, moderate: 9, minor: 9)
Pass: no (0 critical, 5 serious)

| Area | Critical | Serious | Moderate | Minor | Highlights |
|---|---|---|---|---|---|
| Panels | 0 | 5 | 9 | 9 | z-index smells 3, dialog semantics 7, popover/menu behavior 5, motion gaps 5, compositor costs 3 |

## 1. Panels

### Serious (5)

#### atelier/runtime-ux/backdrop-filter-on-video-modal
- Description: backdrop-filter on a modal that contains a video or iframe, which re-runs the blur on every video frame.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter
- Instances (1):
  - `dialog.trailer` at css/panels.css:42:18: `dialog.trailer { backdrop-filter: blur(8px) }`
    backdrop-filter on a modal that holds \<video> or \<iframe> (#trailer); the blur re-runs every frame

#### atelier/runtime-ux/destructive-dialog-closedby-any
- Description: A destructive confirmation <dialog> uses closedby="any", so a stray click outside dismisses it.
- Confidence: medium
- Help: https://html.spec.whatwg.org/multipage/interactive-elements.html#attr-dialog-closedby
- Instances (1):
  - `#confirm-delete` at index.html:50:29: `<dialog id="confirm-delete" closedby="any" aria-labelledby="confirm-title">`
    closedby="any" on a "delete" confirmation; use closedby="closerequest" so only Escape or a button closes it

#### atelier/runtime-ux/dialog-missing-label
- Description: A <dialog> has no accessible name (aria-label, aria-labelledby or title), so screen readers announce it without a title.
- Confidence: high
- Help: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- Instances (1):
  - `#settings` at index.html:45:1: `<dialog id="settings">`
    no aria-labelledby, aria-label or title; point aria-labelledby at the dialog heading

#### atelier/runtime-ux/menu-no-arrow-keys
- Description: role="menu" or "menubar" promises arrow-key navigation, but no script handles ArrowUp or ArrowDown.
- Confidence: medium
- Help: https://www.w3.org/WAI/ARIA/apg/patterns/menubar/
- Instances (1):
  - `#menu-pop` at index.html:27:47: `<div id="menu-pop" class="dropdown" popover role="menu">`
    role="menu" but no keydown handler for ArrowUp/ArrowDown

#### atelier/runtime-ux/tooltip-focusable
- Description: A role="tooltip" element can take focus or receives focus from a script; tooltips must never be focused.
- Confidence: high
- Help: https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/
- Instances (2):
  - `#info-tip` at index.html:33:37: `<div id="info-tip" role="tooltip" tabindex="0">`
    role="tooltip" element is focusable (tabindex="0")
  - `script[src="js/panels.js"]` at js/panels.js:40:3: `document.getElementById('info-tip').focus()`
    focus() moves focus into role="tooltip" element #info-tip

### Moderate (9)

#### atelier/runtime-ux/anchor-name-no-supports
- Description: Anchor positioning is used outside @supports and without a polyfill, so browsers without it show an unanchored panel.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning
- Instances (2):
  - `.tip-anchor` at index.html:10:15: `.tip-anchor { anchor-name: --tip }`
    anchor-name outside @supports (anchor-name: --a) and no polyfill; add a fallback position for older browsers
  - `.flyout-pos` at index.html:14:15: `.flyout-pos { position-anchor: --tip }`
    position-anchor outside @supports (anchor-name: --a) and no polyfill; add a fallback position for older browsers

#### atelier/runtime-ux/backdrop-as-sibling-div
- Description: A hand-made backdrop element sits next to or around a modal; a modal <dialog> gets ::backdrop for free.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/::backdrop
- Instances (1):
  - `body > div.modal-backdrop:nth-of-type(1)` at index.html:64:1: `<div class="modal-backdrop">`
    ".modal-backdrop" backs modal body > div.modal:nth-of-type(3); style dialog::backdrop instead

#### atelier/runtime-ux/backdrop-filter-on-opaque-fill
- Description: backdrop-filter sits behind a fill that is at least 90% opaque, so the blur is invisible but still costs a compositor layer.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter
- Instances (1):
  - `.site-nav` at css/panels.css:15:3: `.site-nav { backdrop-filter: blur(16px) }`
    backdrop-filter: blur(16px) over background: rgba(10, 10, 15, 0.96) (alpha 0.96); the blur cannot show through, drop it

#### atelier/runtime-ux/custom-outside-click-on-auto-popover
- Description: A page-level click listener closes popovers by hand although popover="auto" already light-dismisses.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/API/Popover_API
- Instances (1):
  - `script[src="js/panels.js"]` at js/panels.js:28:1: `document.addEventListener('click', (event) => { const menu = document.getElementById('menu-pop'); if (!menu.contains(event.target)) menu.hidePopover(); })`
    document click listener dismisses popovers by hand; popover="auto" already closes on an outside click

#### atelier/runtime-ux/div-role-dialog
- Description: A modal built from a non-dialog element with role="dialog"; a native <dialog> opened with showModal() handles focus, inertness and Escape.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog
- Instances (1):
  - `body > div.modal:nth-of-type(3)` at index.html:66:20: `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="legacy-title">`
    \<div role="dialog" aria-modal="true">: use \<dialog> with showModal()

#### atelier/runtime-ux/fixed-nav-backdrop-filter-under-modal
- Description: A fixed element keeps its backdrop-filter while a modal covers it, so the blur is recomputed under the modal on every paint.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter
- Instances (1):
  - `.site-nav` at css/panels.css:15:3: `.site-nav { backdrop-filter: blur(16px) }`
    fixed ".site-nav" keeps backdrop-filter under an open modal; hide it or set backdrop-filter: none while the modal is open

#### atelier/runtime-ux/motion-no-reduced-motion-guard
- Description: A panel moves (transition or animation) with no prefers-reduced-motion override.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion
- Instances (1):
  - `.sheet` at css/panels.css:80:10: `.sheet { animation: slide-up 600ms ease-out }`
    ".sheet" moves with no prefers-reduced-motion: reduce override

#### atelier/runtime-ux/no-starting-style-on-transitioned-popover
- Description: A popover or dialog declares a transition but no @starting-style, so it appears without its entry animation.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/@starting-style
- Instances (1):
  - `[popover].dropdown` at css/panels.css:50:3: `[popover].dropdown { transition: opacity 0.2s, display 0.2s allow-discrete }`
    "\[popover\].dropdown" transitions without a matching @starting-style, so the entry is not animated

#### atelier/runtime-ux/z-index-literal-smell
- Description: A magic "always on top" z-index such as 9999 or 2147483647; the top layer (showModal, popover) replaces it.
- Confidence: high
- Help: https://drafts.csswg.org/css-position-4/#top-layer
- Instances (2):
  - `:root` at css/panels.css:4:3: `:root { --z-modal: 2147483647 }`
    --z-modal 2147483647 is an "always on top" literal; use a small z-index scale, or the top layer for dialogs and popovers
  - `.cookie-banner` at css/panels.css:27:46: `.cookie-banner { z-index: 99999 }`
    z-index 99999 is an "always on top" literal; use a small z-index scale, or the top layer for dialogs and popovers

### Minor (9)

#### atelier/runtime-ux/custom-escape-on-dialog-popover
- Description: A keydown Escape handler closes modal dialogs or auto popovers, which already close on Escape.
- Confidence: low
- Help: https://developer.mozilla.org/en-US/docs/Web/API/Popover_API
- Instances (1):
  - `script[src="js/panels.js"]` at js/panels.js:18:1: `document.addEventListener('keydown', (event) => { if (event.key === 'Escape') settings.close(); })`
    Escape handler calls close() although every dialog opens with showModal(), which closes on Escape by itself

#### atelier/runtime-ux/exit-not-faster-than-enter
- Description: A panel closes more slowly than it opens; exits should be as fast as or faster than entries.
- Confidence: medium
- Help: https://m3.material.io/styles/motion/overview
- Instances (1):
  - `.drawer` at css/panels.css:68:3: `.drawer { transition: transform 450ms ease-in }`
    exit 450ms > enter 200ms

#### atelier/runtime-ux/fixed-max-height-no-overflow
- Description: A panel caps its height in px without overflow: auto or scroll, so longer content is clipped or spills out.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/overflow
- Instances (1):
  - `[popover].dropdown` at css/panels.css:49:3: `[popover].dropdown { max-height: 320px }`
    max-height: 320px without overflow: auto or scroll; taller content is clipped or spills out

#### atelier/runtime-ux/focus-trap-library-near-dialog
- Description: A focus-trap library ships next to a native <dialog>; showModal() already keeps focus inside the dialog.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog
- Instances (2):
  - `body > script:nth-of-type(1)` at index.html:70:9: `<script src="js/vendor/focus-trap.umd.js">`
    loads js/vendor/focus-trap.umd.js next to a native \<dialog>
  - `script[src="js/panels.js"]` at js/panels.js:3:14: `window.focusTrap.createFocusTrap('#settings')`
    createFocusTrap() next to a native \<dialog>

#### atelier/runtime-ux/inert-with-showmodal
- Description: Code that calls showModal() also sets inert by hand; a modal dialog already makes the rest of the page inert.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert
- Instances (1):
  - `script[src="js/panels.js"]` at js/panels.js:8:3: `settings.showModal()`
    showModal() already makes the rest of the page inert; drop the manual inert toggle next to it

#### atelier/runtime-ux/motion-duration-off-token
- Description: A panel duration is more than 25% away from every brand motion.duration token.
- Confidence: high
- Help: https://m3.material.io/styles/motion/overview
- Instances (1):
  - `.sheet` at css/panels.css:80:10: `.sheet { animation: slide-up 600ms ease-out }`
    600ms is 50% off long=400ms

#### atelier/runtime-ux/stale-inset-area
- Description: inset-area is the pre-release name of position-area.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning
- Instances (2):
  - `.flyout-pos` at index.html:14:39: `.flyout-pos { inset-area: bottom }`
    inset-area: bottom was renamed; use position-area: bottom
  - `@position-try --below` at index.html:16:25: `@position-try --below { inset-area: bottom }`
    inset-area: bottom was renamed; use position-area: bottom

#### atelier/runtime-ux/transition-all-on-popover
- Description: transition: all on a popover or dialog animates every changed property, including layout; list the properties instead.
- Confidence: high
- Help: https://web.dev/articles/entry-exit-animations
- Instances (1):
  - `[popover].hint-card` at css/panels.css:58:3: `[popover].hint-card { transition-property: all }`
    transition-property: all transitions every property; name them (opacity, transform, display, overlay)

#### atelier/runtime-ux/z-index-over-budget
- Description: A z-index literal is above the surfaces.zIndexMax budget; top-layer dialogs and popovers need no z-index race.
- Confidence: high
- Help: https://drafts.csswg.org/css-position-4/#top-layer
- Instances (1):
  - `.site-nav` at css/panels.css:13:3: `.site-nav { z-index: 60 }`
    z-index 60 is above the budget of 50 (surfaces.zIndexMax)

## Needs review

None.

## Coverage

- Resources: 1 document, 2 stylesheets, 2 scripts parsed; skipped: none; failed: none
- Rules: 24 total; 23 failed, 0 incomplete, 0 passed, 0 not applicable, 1 skipped (dynamic only), 0 ignored, 0 errors
- Suppressed instances: 2
