/**
 * Hybrid logical clock.
 *
 * Every synced row carries an HLC stamp. Merging is last-write-wins by stamp,
 * so the stamp has to satisfy two things at once: it must track wall-clock time
 * closely enough that "the edit I made later actually wins", and it must be a
 * total order even when two devices have skewed clocks or make edits inside the
 * same millisecond. A hybrid clock gives both — physical millis, plus a counter
 * that breaks ties and absorbs skew, plus the device id as a final tiebreak so
 * two devices can never produce the same stamp.
 *
 * Stamps are formatted as a fixed-width sortable string:
 *   "<48-bit millis, base16, 12 chars>-<16-bit counter, base16, 4 chars>-<deviceId>"
 * which means plain string comparison IS the clock comparison — handy, because
 * that lets SQLite order and compare stamps with no custom collation.
 */
export interface HlcState {
  millis: number;
  counter: number;
  deviceId: string;
}

const MAX_COUNTER = 0xffff;
/** Reject stamps this far ahead of local time (ms) — a badly-set remote clock. */
export const MAX_DRIFT_MS = 60 * 60 * 1000;

export function formatHlc(state: HlcState): string {
  const ms = state.millis.toString(16).padStart(12, "0");
  const ct = state.counter.toString(16).padStart(4, "0");
  return `${ms}-${ct}-${state.deviceId}`;
}

export function parseHlc(stamp: string): HlcState | null {
  const dash1 = stamp.indexOf("-");
  const dash2 = stamp.indexOf("-", dash1 + 1);
  if (dash1 !== 12 || dash2 !== 17) return null;
  const millis = parseInt(stamp.slice(0, 12), 16);
  const counter = parseInt(stamp.slice(13, 17), 16);
  const deviceId = stamp.slice(18);
  if (!Number.isFinite(millis) || !Number.isFinite(counter) || !deviceId) {
    return null;
  }
  return { millis, counter, deviceId };
}

/** Total order over stamps. Because of the fixed-width format this is just
 *  lexicographic comparison — exposed as a function for intent. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A device's local clock. `now` is injected so tests are deterministic and so
 * the Electron main process and the renderer can share one implementation.
 */
export class Clock {
  private millis = 0;
  private counter = 0;

  constructor(
    readonly deviceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Stamp a local edit. */
  tick(): string {
    const wall = this.now();
    if (wall > this.millis) {
      this.millis = wall;
      this.counter = 0;
    } else {
      this.counter++;
      if (this.counter > MAX_COUNTER) {
        this.millis++;
        this.counter = 0;
      }
    }
    return formatHlc({
      millis: this.millis,
      counter: this.counter,
      deviceId: this.deviceId,
    });
  }

  /**
   * Advance past a stamp received from another device, so our next local edit
   * is ordered after everything we've already seen. Returns false (and does not
   * advance) if the remote stamp is unparseable or implausibly far in the
   * future — one device with a wrong clock must not drag ours along with it.
   */
  observe(stamp: string): boolean {
    const remote = parseHlc(stamp);
    if (!remote) return false;
    const wall = this.now();
    if (remote.millis - wall > MAX_DRIFT_MS) return false;

    const maxMillis = Math.max(wall, this.millis, remote.millis);
    if (maxMillis === this.millis && maxMillis === remote.millis) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (maxMillis === this.millis) {
      this.counter++;
    } else if (maxMillis === remote.millis) {
      this.counter = remote.counter + 1;
    } else {
      this.counter = 0;
    }
    this.millis = maxMillis;
    return true;
  }
}
