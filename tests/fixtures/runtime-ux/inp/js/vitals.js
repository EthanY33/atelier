import { onCLS, onLCP } from 'web-vitals';

function send(metric) {
  navigator.sendBeacon('/rum', JSON.stringify(metric));
}

onCLS(send);
onLCP(send);
