var carousel = document.querySelector('.carousel');
var feed = document.getElementById('feed');

carousel.addEventListener('touchmove', function (e) {
  carouselX = e.touches[0].clientX;
});

carousel.addEventListener('touchstart', onPress, { passive: true });
carousel.addEventListener('mousedown', onPress);

// Near miss: this listener cancels the gesture, so it has to stay non-passive.
feed.addEventListener('touchmove', function (e) {
  if (dragging) e.preventDefault();
}, { passive: false });

document.addEventListener('click', function (e) {
  var card = e.target.closest('.card');
  if (!card) return;
  card.classList.add('is-open');
  var height = card.offsetHeight;
  card.style.setProperty('--open-height', height + 'px');
});

// Near miss: reads first, then writes.
feed.addEventListener('keydown', function () {
  var top = feed.scrollTop;
  feed.style.transform = 'translateY(' + -top + 'px)';
});

function onPress() {}

async function renderAll(items) {
  for (const item of items) {
    renderItem(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Near miss: the recommended yield with a setTimeout fallback.
async function renderAllYielding(items) {
  for (const item of items) {
    renderItem(item);
    if (globalThis.scheduler && scheduler.yield) await scheduler.yield();
    else await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function loadConfig() {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/config.json', false);
  xhr.send();
  return JSON.parse(xhr.responseText);
}

// Near miss: an async request.
function loadFeed() {
  var req = new XMLHttpRequest();
  req.open('GET', '/api/feed.json', true);
  req.send();
}

new PerformanceObserver(function (list) { report(list.getEntries()); }).observe({ type: 'longtask', buffered: true });
