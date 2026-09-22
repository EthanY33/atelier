// Panels fixture script. The audit parses it and never runs it.
const settings = document.getElementById('settings');
const trap = window.focusTrap.createFocusTrap('#settings');

document.getElementById('open-settings').addEventListener('click', () => {
  document.querySelector('main').inert = true;
  trap.activate();
  settings.showModal();
});

// Near miss: opening a dialog without touching inert.
function openConfirm() {
  document.getElementById('confirm-delete').showModal();
}
document.getElementById('delete-project').addEventListener('click', openConfirm);

// Escape already closes a modal dialog.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') settings.close();
});

// Near miss: the notes popover is manual, so a custom Escape is needed.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.getElementById('notes').hidePopover();
});

// An auto popover already light-dismisses.
document.addEventListener('click', (event) => {
  const menu = document.getElementById('menu-pop');
  if (!menu.contains(event.target)) menu.hidePopover();
});

// Near miss: an outside-click handler for something that is not a popover.
document.addEventListener('pointerdown', (event) => {
  const nav = document.querySelector('.site-nav');
  if (!nav.contains(event.target)) nav.classList.remove('expanded');
});

function showTip() {
  document.getElementById('info-tip').focus();
}
document.getElementById('open-settings').addEventListener('mouseenter', showTip);
document.getElementById('open-settings').focus();
