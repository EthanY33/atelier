var hero = document.querySelector('.hero');
var ticking = false;

window.addEventListener('scroll', function () {
  if (!ticking) {
    requestAnimationFrame(updateHero);
    ticking = true;
  }
}, { passive: true });

function updateHero() {
  hero.style.transform = 'translateY(' + window.scrollY * 0.4 + 'px)';
  ticking = false;
}

// Near miss: the JS fallback only runs without scroll-driven animations.
var header = document.querySelector('.site-header');
if (!CSS.supports('animation-timeline: scroll()')) {
  window.addEventListener('scroll', function () {
    header.style.opacity = String(Math.max(0, 1 - window.scrollY / 200));
  }, { passive: true });
}

// Near miss: a discrete state change, not a scroll-linked animation.
window.addEventListener('scroll', function () {
  header.style.transform = window.scrollY > 400 ? 'translateY(-100%)' : 'none';
}, { passive: true });

window.addEventListener('wheel', function (e) {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });

// Near miss: a root touch listener is passive by default.
document.addEventListener('touchstart', function (e) {
  lastTouch = e.timeStamp;
});
