window.addEventListener('unload', function () { navigator.sendBeacon('/x'); });
// atelier-ignore fake-js-unload
window.addEventListener('unload', flush);
document.addEventListener('touchstart', onTouch, { passive: false });
function onTouch(e) { e.preventDefault(); }
function flush() {}
