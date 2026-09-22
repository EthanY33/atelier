export function init() {
  if (!document.startViewTransition) return;
  document.startViewTransition(() => {});
}
