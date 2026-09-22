// A well-behaved page: native dialog, passive listeners, pagehide instead of
// unload, and view transitions behind a feature check.
const signup = document.getElementById('signup');
document.getElementById('subscribe').addEventListener('click', () => signup.showModal());

window.addEventListener('pagehide', () => {
  navigator.sendBeacon('/collect', JSON.stringify({ type: 'exit' }));
});

document.addEventListener('touchstart', () => {}, { passive: true });

function reorder(list) {
  const items = Array.from(list.children).reverse();
  items.forEach((item) => list.appendChild(item));
}

document.querySelectorAll('.save').forEach((button) => {
  button.addEventListener('click', () => {
    const list = button.closest('.cards');
    if (!document.startViewTransition) {
      reorder(list);
      return;
    }
    document.startViewTransition(() => reorder(list));
  });
});
