// Trailhead mobile fixture script. Parsed by the audit, never executed.

// Pinch tracking on the whole document: non-passive, but it only cancels
// while two fingers are down.
let pinching = false;
document.addEventListener('touchmove', function onTouchMove(e) {
  pinching = e.touches.length > 1;
  if (pinching) e.preventDefault();
}, { passive: false });

// Wheel handler that swallows every scroll to drive a custom scroller.
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  customScrollBy(e.deltaY);
}, { passive: false });

// Near miss: a passive listener on the same target.
window.addEventListener('touchstart', trackTouch, { passive: true });

// Double-tap guard written by hand.
let lastTap = 0;
document.querySelector('.product-carousel').addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTap < 350) {
    e.preventDefault();
  }
  lastTap = now;
});

// Push prompt without an installed-app check.
document.querySelector('.account-btn').addEventListener('click', async () => {
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    const reg = await navigator.serviceWorker.ready;
    await reg.pushManager.subscribe({ userVisibleOnly: true });
  }
});

// Near miss: the second prompt only runs inside the installed app.
function offerAlerts() {
  if (!window.matchMedia('(display-mode: standalone)').matches) return;
  Notification.requestPermission();
}

if (window.FastClick) {
  FastClick.attach(document.body);
}

function trackTouch() {}
function customScrollBy() {}
offerAlerts();
