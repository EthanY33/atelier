// Page lifecycle and navigation helpers for the fixture shop.
window.addEventListener('unload', function () {
  navigator.sendBeacon('/analytics/exit');
});

window.addEventListener('beforeunload', function (event) {
  if (cart.dirty) event.preventDefault();
});

// Near miss: only warns once the form has unsaved input.
document.querySelector('form').addEventListener('input', () => {
  window.addEventListener('beforeunload', warnUnsaved);
});

function showProduct(id) {
  document.startViewTransition(() => render(id));
}

// Near miss: feature check with an early return.
function showCart() {
  if (!document.startViewTransition) {
    renderCart();
    return;
  }
  document.startViewTransition(renderCart);
}

document.querySelector('.products').addEventListener('click', (event) => {
  showProduct(event.target.dataset.id);
});
document.querySelector('.cart').addEventListener('click', showCart);
