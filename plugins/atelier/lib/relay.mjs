/**
 * Which signals the atelier wrapper relays to the skill process it spawns.
 *
 * With a terminal on any of stdin, stdout or stderr, Ctrl+C is delivered to
 * the whole foreground process group, so the skill already received SIGINT;
 * relaying it again would defeat the skill's graceful first-press cleanup.
 * In that case the wrapper must not die on SIGINT either (swallowSigint), so
 * it stays alive until the skill exits and reports the skill's real exit code.
 * Without a terminal nothing else delivers SIGINT to the skill, so it is
 * relayed like SIGTERM and SIGHUP.
 */
export function relaySignals(hasTty) {
  return hasTty
    ? { signals: ['SIGTERM', 'SIGHUP'], swallowSigint: true }
    : { signals: ['SIGINT', 'SIGTERM', 'SIGHUP'], swallowSigint: false };
}

export function hasTerminal(proc = process) {
  return Boolean(proc.stdin.isTTY || proc.stdout.isTTY || proc.stderr.isTTY);
}
