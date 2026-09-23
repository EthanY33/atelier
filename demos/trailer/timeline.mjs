// atelier 1.0 trailer timeline, shared by the scene (index.html) and the
// audio renderer (scripts/trailer/render-audio.mjs) so every keystroke tick
// and success tone lands on the frame that shows it.
//
// The session is reconstructed, but its facts are real: the plugin install
// lines come from `claude plugin install`, the doctor block from
// `atelier doctor`, the audit findings and the clean re-run from `atelier ux`
// on tests/fixtures/runtime-ux/e2e (and its clean/ variant), and the panels
// show files the skills generated for a demo brand.

export const FPS = 60;

const CPS = 14; // typing speed, characters per second (rules: 13 to 15)

// Seeded PRNG so the scene and the audio agree on every jitter.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const DOCTOR = [
  ['ok', 'node', 'v22.13.0'],
  ['ok', 'dependencies', '9 of 9 resolve'],
  ['ok', 'sharp', 'libvips 8.18.6'],
  ['ok', 'chromium', '153.0.8010.12'],
  ['ok', 'ffmpeg', '8.1'],
  ['ok', 'brand.json', 'Kiln (3 colors)'],
];

export const FINDINGS = [
  ['critical', 'no-unload-handler', 'js/analytics.js:3'],
  ['serious', 'vta-no-feature-check', 'js/app.js:23'],
  ['serious', 'uses-vh-without-dvh', 'css/site.css:40'],
  ['serious', 'hover-only-affordance', 'css/site.css:74'],
];

export const CI_JOBS = [
  'Test (ubuntu-latest, Node 22)', 'Test (ubuntu-latest, Node 24)',
  'Test (macos-latest, Node 22)', 'Test (macos-latest, Node 24)',
  'Test (windows-latest, Node 22)', 'Test (windows-latest, Node 24)',
  'Installed-plugin smoke (ubuntu-latest)', 'Installed-plugin smoke (macos-latest)',
  'Installed-plugin smoke (windows-latest)', 'Validate schemas and manifests',
  'GitHub Action self-test (caller on Node 20)', 'GitHub Action self-test (caller on Node 24)',
];

/**
 * Build the absolute timeline.
 * @returns {{
 *   duration: number,
 *   term: Array<object>,     terminal events: prompt, char, enter, line, clear
 *   panels: Record<string, { in: number, out: number }>,
 *   marks: Record<string, number>,
 *   cues: Array<{ t: number, sample: string, gain: number, opts?: object }>,
 * }}
 */
export function buildTimeline(seed = 0x5a7e11e7) {
  const rand = rng(seed);
  const term = [];
  const panels = {};
  const marks = {};
  const cues = [];
  let t = 0;
  const cue = (sample, gain, opts) => cues.push({ t, sample, gain, opts });
  const wait = (s) => { t += s; };
  const prompt = () => term.push({ t, kind: 'prompt' });
  const type = (text) => {
    let typed = '';
    for (const ch of text) {
      typed += ch;
      term.push({ t, kind: 'char', typed });
      if (ch !== ' ') cue('typewriter', 0.022 + rand() * 0.014, { lowpass: 4500, dur: 0.07 });
      t += (1 / CPS) * (0.8 + rand() * 0.4);
    }
  };
  const enter = () => { wait(0.22); term.push({ t, kind: 'enter' }); cue('click-soft', 0.34, { lowpass: 5000 }); wait(0.18); };
  const line = (html, gap = 0.12) => { term.push({ t, kind: 'line', html }); wait(gap); };
  const clear = () => term.push({ t, kind: 'clear' });
  const show = (name) => { panels[name] = { in: t, out: Infinity }; };
  const hide = (name) => { panels[name].out = t; };

  // Intro: cursor glides to the terminal icon and clicks.
  marks.introClick = 1.05;
  t = 1.05;
  cue('click-soft', 0.4, { lowpass: 5000 });
  wait(0.2);
  marks.open = t;
  wait(0.5);
  // History already in the scrollback when the window opens.
  term.push({ t: marks.open, kind: 'line', html: '<span class="pr">›</span> /plugin marketplace add EthanY33/atelier' });
  term.push({ t: marks.open, kind: 'line', html: '<span class="ok">✔</span> Successfully added marketplace: <b>atelier</b>' });

  // 1. Install.
  prompt();
  wait(0.25);
  type('/plugin install atelier@atelier');
  enter();
  line('<span class="dim">installing dependencies (npm ci)…</span>', 0.5);
  line('<span class="ok">✔</span> Successfully installed plugin: <b>atelier@atelier</b>', 0.1);
  cue('chime', 0.30);
  show('pkg');
  wait(1.05);

  // 2. Doctor.
  prompt();
  type('/atelier-doctor');
  enter();
  line('<span class="dim">atelier 1.0.0 doctor</span>', 0.1);
  for (const [s, name, detail] of DOCTOR) {
    line(`  <span class="ok">${s}</span>    <span class="nm">${name.padEnd(12)}</span>  ${detail}`, 0.1);
  }
  line('<span class="ok">Ready.</span>', 0.2);
  wait(0.55);
  hide('pkg');
  cue('whoosh', 0.3);
  wait(0.3);
  clear();

  // 3. Ask for social cards.
  prompt();
  type('make social cards for every post in /blog');
  enter();
  line('<span class="tool">⏺</span> <b>og-card-generator</b>', 0.16);
  line('  <span class="dim">⎿</span> og/launch-week.png', 0.08);
  line('  <span class="dim">⎿</span> og/brand-refresh.png', 0.08);
  line('  <span class="dim">⎿</span> og/field-notes.png', 0.05);
  show('cards');
  marks.cards = t;
  for (let i = 0; i < 3; i++) { cue('click-soft', 0.2, { lowpass: 5000 }); wait(0.22); }
  wait(0.95);

  // 4. Rebrand: change one line, regenerate.
  show('diff');
  marks.diff = t;
  cue('click-soft', 0.22, { lowpass: 5000 });
  wait(0.6);
  marks.diffEdit = t;
  cue('click-snap', 0.1, { lowpass: 5000 });
  wait(0.5);
  prompt();
  type('regenerate the brand assets');
  enter();
  line('<span class="tool">⏺</span> <b>design-token-sync</b>  <span class="dim">⎿</span> 5 token files', 0.16);
  line('<span class="tool">⏺</span> <b>og-card-generator</b>  <span class="dim">⎿</span> 3 cards', 0.16);
  line('<span class="tool">⏺</span> <b>brand-asset-pipeline</b>  <span class="dim">⎿</span> icons', 0.1);
  marks.recolor = t;
  cue('click-snap', 0.11, { lowpass: 5000 });
  show('icons');
  wait(1.75);
  hide('cards');
  hide('diff');
  hide('icons');
  cue('whoosh', 0.3);
  wait(0.3);
  clear();

  // 5. runtime-ux-audit.
  prompt();
  type('/ux-audit site/index.html');
  enter();
  show('report');
  marks.report = t;
  for (const [sev, id, where] of FINDINGS) {
    line(`<span class="sev ${sev}">${sev.padEnd(8)}</span> ${id.padEnd(22)} <span class="dim">${where}</span>`, 0.13);
    cue('click-soft', 0.16, { lowpass: 5000 });
  }
  line('<span class="bad">critical 1, serious 3, moderate 3 · exit 1</span>', 0.1);
  wait(1.0);
  prompt();
  type('fix those and re-run');
  enter();
  line('<span class="dim">pagehide, feature check, 100dvh, focus-visible</span>', 0.35);
  marks.reportPass = t;
  cue('chime', 0.3);
  line('<span class="ok">critical 0, serious 0, moderate 0 · exit 0</span>', 0.1);
  wait(1.3);
  hide('report');
  cue('whoosh', 0.28);
  wait(0.25);

  // 6. CI: twelve jobs go green.
  show('ci');
  marks.ci = t;
  for (let i = 0; i < CI_JOBS.length; i++) wait(0.085);
  marks.ciDone = t;
  cue('click-snap', 0.1, { lowpass: 5000 });
  wait(1.0);

  // 7. Endcard.
  marks.end = t;
  cue('whoosh', 0.26);
  wait(0.7);
  marks.endIn = t;
  wait(1.4);

  return { duration: Math.ceil(t * 10) / 10, term, panels, marks, cues };
}
