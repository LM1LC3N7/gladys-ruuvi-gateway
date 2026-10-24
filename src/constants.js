// -----------------------------------------------------------------------------
// Limits, pacing and the keys users store (manifest keys, device types): the
// keys are forever, never rename them.
// -----------------------------------------------------------------------------

export const USER_AGENT =
  'gladys-ruuvi-gateway (+https://github.com/LM1LC3N7/gladys-ruuvi-gateway)';

/** One HTTP call to the gateway (a small ESP32 on the local network). */
export const HTTP_TIMEOUT = 10_000;

/** The most an answer may weigh (about 150 bytes per tag). */
export const MAX_BODY = 1024 * 1024;

/** At most this many entries of an answer are looked at. */
export const MAX_ENTRIES = 1000;

/** At most this many tags are published. */
export const MAX_TAGS = 50;

/**
 * The longest relayed frame taken (hex characters): a legacy Bluetooth
 * advertisement holds 31 bytes, an extended one up to 255.
 */
export const MAX_FRAME_HEX = 512;

/** A tag neither heard nor created in Gladys for this long leaves the Discovery list. */
export const FORGET_AFTER = 7 * 24 * 60 * 60_000;

/** How often the integration checks what is due. */
export const TICK = 15_000;

/**
 * The state file under /data is written at most once per minute (flash
 * memory, restart loops): a read waits for that too.
 */
export const WRITE_GAP = 60_000;

/**
 * 429 / 5xx: a pause, from Retry-After when given, else 5 minutes doubling;
 * always between 1 minute and 6 hours.
 */
export const BUSY_MIN = 60_000;
export const BUSY_BASE = 5 * 60_000;
export const BUSY_MAX = 6 * 60 * 60_000;

/** A measurement older than this is never published (dated or not), whatever the interval. */
export const STALE = 60 * 60_000;

/**
 * A new measurement at most max(RECENT_MIN, interval + RECENT_MARGIN) old is
 * published as current; older (up to STALE), it is published dated.
 */
export const RECENT_MIN = 5 * 60_000;
export const RECENT_MARGIN = 2 * 60_000;

/** A frame more than this in the future of the gateway clock is ignored. */
export const FUTURE_TOLERANCE = 5 * 60_000;

/**
 * An unchanged value of a NEW measurement is re-sent after this (a
 * measurement already published is never handed to the SDK again, so this
 * never refreshes a silent tag).
 */
export const HEARTBEAT = 30 * 60_000;

/** The core accepts 300 states per minute: the integration keeps a margin. */
export const STATES_PER_MINUTE = 250;

/** The test button answers within this, with the last values if needed. */
export const TEST_DEADLINE = 50_000;

/** Where the pace, the pauses, the refusal and the tags met survive a restart. */
export const STATE_FILE = '/data/ruuvi-gateway-state.json';

/** Device type of the external ids (`ext:ruuvi-gateway:tag:<MAC>`). */
export const DEVICE_TYPE = 'tag';

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};
