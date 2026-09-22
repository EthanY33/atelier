// Custom modal: moves focus in, and on Escape hides itself without
// restoring focus, so focus falls back to <body>.
const custom = document.getElementById('custom');
document.getElementById('open-custom').addEventListener('click', () => {
  custom.hidden = false;
  document.getElementById('custom-close').focus();
});
document.getElementById('custom-close').addEventListener('click', () => {
  custom.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !custom.hidden) custom.hidden = true;
});

// Native modal dialog: the browser restores focus to the opener on close.
const native = document.getElementById('native');
document.getElementById('open-native').addEventListener('click', () => native.showModal());
