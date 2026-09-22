// A click handler that blocks the main thread for 150 ms.
function onBuy() {
  const start = performance.now();
  while (performance.now() - start < 150) {
    // busy wait
  }
  document.getElementById('status').textContent = 'Bought';
}
document.getElementById('buy').addEventListener('click', onBuy);
