// Page-exit beacon. An unload listener keeps the page out of the
// back/forward cache; pagehide or visibilitychange would not.
window.addEventListener('unload', function () {
  navigator.sendBeacon('/collect', JSON.stringify({ type: 'exit' }));
});
