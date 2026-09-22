(function () {
  ga('create', 'UA-000000-1', 'auto');
  ga('send', 'pageview');
  // atelier-ignore analytics-without-prerender-guard -- the consent banner delays this pixel
  fbq('track', 'PageView');
})();

// Not flagged: Google's tag library waits for prerender activation itself.
gtag('event', 'page_view');
