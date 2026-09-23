// atelier 1.0 trailer timeline, shared by the scene (index.html) and the
// audio renderer (scripts/trailer/render-audio.mjs) so every keystroke and
// success tone lands on the frame that shows it.
//
// The Claude Code session is reconstructed, but its facts are real: the
// plugin install lines come from `claude plugin install`, and every atelier
// command shows its real output for the Kiln demo brand, with absolute paths
// shortened. The audit is tests/fixtures/runtime-ux/e2e; the four edits are
// the smallest fixes for its blocking findings, and the re-run output is the
// audit of the fixed copy.

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

// Slash commands the menu filters while a command is typed, with the
// descriptions from each command file (atelier's are shortened to fit a row).
export const COMMANDS = [
  ['/add-dir', 'Add a new working directory'],
  ['/agents', 'Manage agent configurations'],
  ['/atelier-demo', 'Run every atelier skill on the bundled sample brand (atelier)'],
  ['/atelier-doctor', 'Check that atelier can run here (atelier)'],
  ['/brand-audit', 'List the recommended fields missing from brand.json (atelier)'],
  ['/plugin', 'Manage Claude Code plugins'],
  ['/ux-audit', 'Audit a URL or local HTML file for runtime UX problems (atelier)'],
];

const KEYS = ['key-1', 'key-2', 'key-3', 'key-4', 'key-5', 'key-6'];

// Audio cue gains are target peak levels (linear, 1 = 0 dBFS); render-audio
// divides by each sample's own peak so every variant lands at the same level.
const LEVEL = { key: 0.1, space: 0.075, enter: 0.12, click: 0.06, chime: 0.09 };

/**
 * Build the absolute timeline.
 * @returns {{
 *   duration: number,
 *   term: Array<object>,   events: welcome, row, submit, char, tool, spin, spinEnd
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
  let lastKey = -1;
  let spinStart = 0;
  const cue = (sample, gain, opts) => cues.push({ t, sample, gain, opts });
  const wait = (s) => { t += s; };
  const ev = (kind, extra = {}) => { term.push({ t, kind, ...extra }); return term[term.length - 1]; };
  const row = (html, gap = 0.06) => { ev('row', { html }); wait(gap); };
  const block = (html, gap = 0.06) => { ev('row', { html: '' }); row(html, gap); };
  const show = (name) => { panels[name] = { in: t, out: Infinity }; };
  const hide = (name) => { panels[name].out = t; };

  // Type into the input box: one keycap per character, the spacebar for spaces.
  const type = (text) => {
    wait(0.25);
    let typed = '';
    for (const ch of text) {
      typed += ch;
      ev('char', { typed });
      if (ch === ' ') cue('key-enter', LEVEL.space * (0.9 + rand() * 0.2));
      else {
        let k;
        do { k = Math.floor(rand() * KEYS.length); } while (k === lastKey);
        lastKey = k;
        cue(KEYS[k], LEVEL.key * (0.85 + rand() * 0.3));
      }
      t += (1 / CPS) * (0.8 + rand() * 0.4);
    }
  };
  // Enter moves the prompt into the history; a model turn starts the spinner.
  const submit = (text, verb) => {
    wait(0.22);
    ev('submit', { text });
    cue('key-enter', LEVEL.enter);
    wait(0.3);
    if (verb) { spinStart = t; ev('spin', { verb }); wait(0.25); }
  };
  const done = (past) => {
    const secs = Math.max(1, Math.round(t - spinStart));
    ev('spinEnd');
    block(`<span class="dim">✻ ${past} for ${secs}s</span>`, 0);
  };
  // A tool call shows a blinking dot until its result lands, then green or red.
  const tool = (name, arg, secs, ok, lines) => {
    ev('row', { html: '' });
    const call = ev('tool', { html: `<b>${name}</b>(${arg})`, ok, doneAt: t + secs });
    wait(secs);
    lines.forEach((l, i) => row(`${i === 0 ? '  <span class="dim">⎿</span>  ' : '     '}${l}`, 0.05));
    return call;
  };
  const say = (html, gap = 0.06) => block(`<span class="say">●</span> ${html}`, gap);
  const more = (n) => `<span class="dim">… +${n} line${n === 1 ? '' : 's'} (ctrl+o to expand)</span>`;

  // Intro: the cursor glides to the Claude Code icon and clicks; the session
  // opens on the welcome box with the marketplace already added.
  marks.introClick = 1.05;
  t = 1.05;
  cue('click-soft', LEVEL.click * 1.3);
  wait(0.2);
  marks.open = t;
  ev('welcome');
  ev('row', { html: '' });
  ev('row', { html: '<span class="dim">›</span> /plugin marketplace add EthanY33/atelier', band: true });
  ev('row', { html: '  <span class="dim">⎿</span>  Successfully added marketplace: <b>atelier</b>' });
  wait(0.8);

  // 1. Install.
  type('/plugin install atelier@atelier');
  submit('/plugin install atelier@atelier');
  wait(0.5);
  row('  <span class="dim">⎿</span>  <span class="ok">✔</span> Successfully installed plugin: <b>atelier@atelier</b>', 0);
  cue('chime', LEVEL.chime);
  show('pkg');
  wait(1.1);

  // 2. Doctor.
  type('/atelier-doctor');
  submit('/atelier-doctor', 'Percolating');
  tool('Bash', 'atelier doctor', 0.55, true, [
    '<span class="ok">ok</span>    node          v22.13.0',
    '<span class="ok">ok</span>    dependencies  9 of 9 resolve',
    '<span class="ok">ok</span>    sharp         libvips 8.18.6',
    more(5),
  ]);
  wait(0.35);
  say('All six checks pass, so every skill can run here.', 0.2);
  done('Percolated');
  wait(0.8);
  hide('pkg');
  wait(0.15);

  // 3. Social cards.
  type('make social cards for every post in /blog');
  submit('make social cards for every post in /blog', 'Forging');
  tool('Skill', 'og-card-generator', 0.3, true, ['Successfully loaded skill']);
  wait(0.25);
  tool('Bash', 'atelier og blog/pages.json --out og', 0.55, true, [
    'Generated 3 OG card(s):',
    '  og/launch-week.png',
    '  og/brand-refresh.png',
    more(1),
  ]);
  show('cards');
  marks.cards = t;
  for (let i = 0; i < 3; i++) { cue('click-soft', LEVEL.click * 0.7); wait(0.22); }
  wait(0.2);
  say('Three 1200x630 cards in og/, one per post, on the Kiln brand.', 0.2);
  done('Forged');
  wait(0.9);

  // 4. Rebrand: one value changes, everything downstream regenerates.
  type('switch palette.bg to #16305f and regenerate');
  submit('switch palette.bg to #16305f and regenerate', 'Crafting');
  show('diff');
  marks.diff = t;
  tool('Bash', "atelier brand set palette.bg '#16305f'", 0.45, true, ['palette.bg = "#16305f"']);
  marks.diffEdit = t - 0.05;
  cue('click-soft', LEVEL.click * 0.8);
  wait(0.4);
  tool('Bash', 'atelier tokens', 0.35, true, [
    'dist/tokens/tokens.css',
    'dist/tokens/tailwind.config.js',
    'dist/tokens/tokens.d.ts',
    more(2),
  ]);
  wait(0.25);
  tool('Bash', 'atelier og blog/pages.json --out og', 0.5, true, ['Generated 3 OG card(s):', '  og/launch-week.png', '  og/brand-refresh.png', more(1)]);
  marks.recolor = t - 0.2;
  wait(0.5);
  tool('Bash', 'atelier assets --root . --out public', 0.45, true, [
    'Wrote 11 files to public (targets: favicons, app-icons, social;',
    'background #16305f)',
  ]);
  marks.icons = t - 0.1;
  show('icons');
  wait(0.4);
  say('Tokens, all three cards and the icons now use the navy background.', 0.2);
  done('Crafted');
  wait(1.5);
  hide('cards');
  hide('diff');
  hide('icons');
  wait(0.3);

  // 5. runtime-ux-audit fails, then the fixes make it pass.
  type('/ux-audit site/index.html');
  submit('/ux-audit site/index.html', 'Cogitating');
  tool('Bash', 'atelier ux site/index.html --out ux-report', 0.7, false, [
    '<span class="bad">Error: Exit code 1</span>',
    'Report written to: ux-report/ux-report.md',
    'Violations: critical 1, serious 3, moderate 3, minor 0',
  ]);
  show('report');
  marks.report = t;
  wait(0.35);
  tool('Read', 'ux-report/ux-report.md', 0.3, true, ['Read <b>98</b> lines']);
  wait(0.3);
  say('Four blocking findings:', 0.05);
  for (const [sev, id, where] of FINDINGS) {
    row(`    <span class="sev ${sev}">${sev.padEnd(9)}</span>${id.padEnd(23)}<span class="dim">site/${where}</span>`, 0.07);
  }
  row('  Want me to fix them?', 0.2);
  done('Cogitated');
  wait(0.7);
  type('yes');
  submit('yes', 'Brewing');
  tool('Update', 'site/js/analytics.js', 0.3, true, ['Updated <b>site/js/analytics.js</b> with <b>1</b> addition and <b>1</b> removal']);
  tool('Update', 'site/js/app.js', 0.3, true, ['Updated <b>site/js/app.js</b> with <b>4</b> additions and <b>2</b> removals']);
  tool('Update', 'site/css/site.css', 0.3, true, ['Updated <b>site/css/site.css</b> with <b>1</b> addition']);
  tool('Update', 'site/css/site.css', 0.3, true, ['Updated <b>site/css/site.css</b> with <b>2</b> additions and <b>1</b> removal']);
  wait(0.2);
  // The report panel flips on the same frame as the passing summary line.
  ev('row', { html: '' });
  const rerun = ev('tool', { html: '<b>Bash</b>(atelier ux site/index.html --out ux-report)', ok: true, doneAt: t + 0.6 });
  wait(0.6);
  marks.reportPass = rerun.doneAt;
  cue('chime', LEVEL.chime);
  row('  <span class="dim">⎿</span>  Report written to: ux-report/ux-report.md', 0.05);
  row('     Violations: <span class="ok">critical 0, serious 0</span>, moderate 3, minor 0', 0.3);
  say('All four fixed. The audit passes (exit 0); 3 moderate notes remain.', 0.2);
  done('Brewed');
  wait(1.3);
  hide('report');
  wait(0.25);

  // 6. CI: twelve jobs go green.
  show('ci');
  marks.ci = t;
  // Job i turns green 0.25 + i * 0.085 s in, over 0.18 s (index.html).
  marks.ciDone = t + 0.25 + (CI_JOBS.length - 1) * 0.085 + 0.18;
  t = marks.ciDone;
  cue('click-soft', LEVEL.click);
  wait(0.85);

  // 7. Endcard.
  marks.end = t;
  wait(0.7);
  marks.endIn = t;
  wait(1.5);

  return { duration: Math.ceil(t * 10) / 10, term, panels, marks, cues };
}
