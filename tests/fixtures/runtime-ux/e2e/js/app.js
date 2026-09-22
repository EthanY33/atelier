// Menu sheet: a div role="dialog" that moves focus in on open and hides
// itself on Escape or Close without returning focus to the menu button.
const sheet = document.getElementById('menu-sheet');
const menuButton = document.getElementById('menu-btn');

function openSheet() {
  sheet.hidden = false;
  document.getElementById('sheet-close').focus();
}

function closeSheet() {
  sheet.hidden = true;
}

menuButton.addEventListener('click', openSheet);
document.getElementById('sheet-close').addEventListener('click', closeSheet);
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && !sheet.hidden) closeSheet();
});

// Filter: re-sorts the grid inside a view transition, with no feature check.
document.getElementById('filter').addEventListener('click', function () {
  document.startViewTransition(function () {
    const grid = document.getElementById('products');
    const items = Array.from(grid.children).reverse();
    items.forEach(function (item) { grid.appendChild(item); });
  });
});

// Parallax hero, driven from a scroll listener.
const hero = document.getElementById('hero');
window.addEventListener('scroll', function () {
  hero.style.transform = 'translateY(' + window.scrollY * 0.3 + 'px)';
}, { passive: true });
