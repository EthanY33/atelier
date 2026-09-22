// Add to cart: recomputes the whole cart synchronously inside the click
// handler, blocking the main thread for about 150 ms per tap.
function addToCart(event) {
  const start = performance.now();
  while (performance.now() - start < 150) {
    // pricing, tax and shipping rules, all on the main thread
  }
  const toast = document.getElementById('toast');
  if (toast && toast.showPopover) toast.showPopover();
  event.currentTarget.textContent = 'Added';
}

document.querySelectorAll('.add').forEach(function (button) {
  button.addEventListener('click', addToCart);
});
