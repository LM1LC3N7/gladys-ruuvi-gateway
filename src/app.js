// -----------------------------------------------------------------------------
// The integration itself: the gateway to read, when it is due, the pauses
// and the refusal, the tags and their measurements, the Gladys devices and
// states, the connection status and the test button. index.js only wires
// the SDK handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './config.js';
import {
  BUSY_BASE,
  BUSY_MAX,
  BUSY_MIN,
  FORGET_AFTER,
  FUTURE_TOLERANCE,
  HEARTBEAT,
  MAX_TAGS,
  RECENT_MARGIN,
  RECENT_MIN,
  STALE,
  STATES_PER_MINUTE,
  TEST_DEADLINE,
  TICK,
} from './constants.js';
import { deviceOf, fieldsOf, isCreated, statesOf, valuesOf } from './fields.js';
import { SourceError, macText, readHistory } from './gateway.js';
import { T, reason } from './i18n.js';
import { decodeFrame } from './ruuvitag.js';
import { GatewayStore, memoryStorage } from './store.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };
const defaultClient = { readHistory };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 12.54 -> "12.5", "12,5" in French. */
const numberText = (value, lang, digits = 1) => {
  const text = String(Math.round(value * 10 ** digits) / 10 ** digits);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

const asSourceError = (err) => (err instanceof SourceError ? err : new SourceError('failed'));

/** "c6a5b9e0ad06" -> "Ruuvi AD06", the name the Ruuvi apps give a tag. */
const tagName = (key) => `Ruuvi ${key.slice(8).toUpperCase()}`;

/**
 * An instant of the gateway (ms), or null when missing or before 2020: a
 * gateway whose clock is not set counts from 1970, its instants prove
 * nothing.
 */
const CLOCK_SET = Date.parse('2020-01-01T00:00:00Z');
const sane = (ms) => (typeof ms === 'number' && ms >= CLOCK_SET ? ms : null);

const newTag = ({ key, fields = [], mark = '', markTs = null, markAt = 0, seenAt = 0 }) => ({
  key,
  name: tagName(key),
  /** Every feature key ever read. */
  fields: new Set(fields),
  /** { values, mark, firstTs, markAt, age, readAt, movement } (see applyHistory). */
  sample: null,
  /** The last measurement handed to Gladys (kept under /data). */
  published: { mark, markTs, markAt },
  /** The last instant (clock of Gladys) the gateway heard the tag. */
  seenAt,
});

export class RuuviGatewayApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'ruuvi-gateway' }),
    now = Date.now,
    timers = defaultTimers,
    storage = memoryStorage(),
    client = defaultClient,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.client = client;
    this.config = normalizeConfig();
    // The pace, the pauses and the refusal live as long as the process,
    // across restarts of the app and reconnections to Gladys, and in /data
    // across restarts of the container.
    this.store = new GatewayStore({ storage, now, timers, maxPause: BUSY_MAX });
    /** `address\nkey` when the gateway is configured, else ''. */
    this.secret = '';
    /** The error of the gateway (refused, busy, failed...), or undefined. */
    this.error = undefined;
    /** tag key (MAC, 12 hex digits) -> tag */
    this.tags = new Map();
    /** Tags heard beyond MAX_TAGS in the last read. */
    this.more = 0;
    /** Frames of the last read not decoded: why -> count. */
    this.ignored = {};
    /** feature external id -> the mark of the measurement last handed to Gladys. */
    this.pushed = new Map();
    this.interval = undefined;
    this.ticking = undefined;
    this.chain = Promise.resolve();
    /** States waiting for room in the per-minute budget: feature id -> state. */
    this.backlog = new Map();
    /** [instant, count] of the states sent in the last minute. */
    this.sentLog = [];
    this.flushTimer = undefined;
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    this.secret = isConfigured(this.config)
      ? `${this.config.address.base}\n${this.config.token}`
      : '';
    if (this.secret) {
      // Other settings drop the refusal and the instant of the last request:
      // they are tried at once. Anything else (a reconnection to Gladys, a
      // restart of the container, a new interval) keeps the pace: the next
      // read is never before the last request + the interval.
      const { entry: saved, changed } = this.store.restore(this.secret);
      if (changed) {
        this.error = undefined;
      }
      if (this.tags.size === 0) {
        // After a restart: the tags known before (MAC, fields, the mark of
        // the last measurement handed to Gladys) keep the Discovery list
        // filled until the next read, and a measurement already published
        // is never sent again.
        for (const tag of saved.tags) {
          this.tags.set(tag.key, newTag(tag));
        }
      }
      // After a restart, the status says at once that the key is refused or
      // the reads paused, without asking the gateway.
      if (saved.refused) {
        this.error = 'refused';
      } else if (!this.error && saved.pausedUntil > this.now()) {
        this.error = 'busy';
      }
    }
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again even when nothing changed.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    await this.tick();
    if (generation !== this.generation) {
      return;
    }
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`)),
      TICK,
    );
    await this.publishDiscovered();
    await this.refreshStatus();
  }

  stop() {
    this.generation += 1;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    // The states still waiting stay, with the instant of their measurement:
    // flushStates() judges them again when they leave (dropped past an
    // hour, dated past recentMs()), however long the stop lasted.
  }

  /** The container stops: the state file is written, the timers dropped. */
  shutdown() {
    this.stop();
    // A clean stop happens once per restart: what waits (the last published
    // marks) is written even before the one-minute gap.
    this.store.flush({ force: true });
    this.store.close();
  }

  /** An error message without the API key. */
  scrub(err) {
    let message = String(err?.message ?? err);
    const key = this.config.token;
    if (key && key.length >= 4) {
      message = message.split(key).join('***');
    }
    return message;
  }

  /** Run `fn` after every read already queued: never two reads at once. */
  exclusive(fn) {
    const run = this.chain.catch(() => {}).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // --- Pace ---------------------------------------------------------------------------

  intervalMs() {
    return this.config.pollMinutes * 60_000;
  }

  /**
   * A measurement this recent is published as current (without a date): the
   * interval plus a margin, 5 minutes at least, never past STALE. Older, up
   * to STALE (1 hour), it is published dated (`created_at`), which fires no
   * scene; older than that, never.
   */
  recentMs() {
    return Math.min(STALE, Math.max(RECENT_MIN, this.intervalMs() + RECENT_MARGIN));
  }

  /**
   * The earliest read: the interval and a pause are always kept; a refused
   * key is never tried again by a periodic read (only the test button, or
   * other settings).
   */
  earliest({ manual = false } = {}) {
    const saved = this.store.get();
    if (saved.refused && !manual) {
      return Infinity;
    }
    return Math.max(saved.lastAttemptAt + this.intervalMs(), saved.pausedUntil);
  }

  /** When the next read can happen (shown by the test button). */
  nextRead() {
    return Math.max(this.earliest({ manual: true }), this.store.writableAt(), this.now());
  }

  // --- Reading -----------------------------------------------------------------------

  /** Read what is due (a tick never overlaps another). */
  tick({ manual = false } = {}) {
    if (!manual && this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    const generation = this.generation;
    const run = this.exclusive(() => this.readDue({ manual })).finally(() => {
      if (this.ticking === run) {
        this.ticking = undefined;
      }
    });
    if (!manual) {
      this.ticking = run;
      this.tickGeneration = generation;
    }
    return run;
  }

  /**
   * Read the gateway when its interval has passed. Nothing, not even the
   * test button (`manual`), reads before the last request + the interval,
   * nor during a pause; `manual` may try a refused key again once the
   * interval has passed. The instant of the request is written to /data
   * before it leaves (a read waits until a write is allowed).
   */
  async readDue({ manual = false } = {}) {
    const generation = this.generation;
    const now = this.now();
    if (!this.secret || now < this.earliest({ manual }) || !this.store.canWrite()) {
      return;
    }
    this.store.update({ lastAttemptAt: now }, undefined, { defer: true });
    this.store.flush();
    await this.readGateway();
    if (generation === this.generation) {
      await this.publish();
      await this.refreshStatus();
    }
  }

  /** One request: the last frame of every tag the gateway heard. */
  async readGateway() {
    const generation = this.generation;
    const secret = this.secret;
    const current = () => generation === this.generation && secret === this.secret;
    try {
      const answer = await this.client.readHistory({
        base: this.config.address.base,
        token: this.config.token,
      });
      if (!current()) {
        return;
      }
      const before = [...this.tags.keys()].join();
      this.applyHistory(answer);
      this.error = undefined;
      const changes = {
        pausedUntil: 0,
        streak: 0,
        refused: false,
        gwMac: answer.gwMac ?? this.store.get().gwMac,
        tags: this.serialize(),
      };
      // A new or forgotten tag is written at once; the rest (the instant a
      // tag was heard) with the next allowed write.
      this.store.update(changes, undefined, { defer: before === [...this.tags.keys()].join() });
    } catch (err) {
      this.failed(asSourceError(err), { current: current(), secret });
    }
  }

  /**
   * The frames of the answer. Each tag keeps its last measurement, told
   * apart by its mark: the measurement sequence number of the frame (RAWv2
   * and Cut-RAWv2), else the instant the gateway heard it (RAWv1), else the
   * frame itself. A frame with the same mark is the same measurement sent
   * again: it changes nothing, so a tag whose sensor stopped measuring is
   * never shown alive by the gateway hearing it.
   *
   * The age of a measurement is counted on the clock of the gateway (the
   * instant it first heard the mark, against the instant of the answer).
   * Without these instants (a gateway without timestamps, or whose clock is
   * not set: the firmware then returns its whole table, old frames
   * included), a mark seen for the first time proves nothing and gives no
   * value; only a mark that changed since the previous read of this process
   * is a recent measurement, at most as old as that previous read.
   */
  applyHistory({ gwTime: rawGwTime, tags }) {
    const readAt = this.now();
    const gwTime = sane(rawGwTime);
    this.ignored = {};
    this.more = 0;
    const accepted = [];
    for (const [key, entry] of tags) {
      const decoded = decodeFrame(entry.data);
      if (!decoded.ok) {
        if (decoded.why !== 'other') {
          this.ignored[decoded.why] = (this.ignored[decoded.why] ?? 0) + 1;
        }
        continue;
      }
      const measure = decoded.measure;
      // The MAC in the frame (RAWv2, Cut-RAWv2) must be the one the gateway
      // filed it under: another one is never taken for this tag.
      if (measure.mac !== null && measure.mac !== key) {
        this.ignored.mac = (this.ignored.mac ?? 0) + 1;
        continue;
      }
      const ts = gwTime === null ? null : sane(entry.ts);
      if (ts !== null && ts - gwTime > FUTURE_TOLERANCE) {
        this.ignored.future = (this.ignored.future ?? 0) + 1;
        continue;
      }
      accepted.push({ key, entry, measure, ts });
    }
    // The places go to the tags created in Gladys first, then to the tags
    // already known, then to new ones: a crowd of tags never pushes out a
    // created one. A created tag takes the place of the known tag not
    // created and heard the longest ago.
    const rank = ({ key }) => (isCreated(this.gladys, key) ? 0 : this.tags.has(key) ? 1 : 2);
    accepted.sort((a, b) => rank(a) - rank(b));
    for (const item of accepted) {
      const { key, entry, measure, ts } = item;
      let tag = this.tags.get(key);
      if (!tag) {
        if (this.tags.size >= MAX_TAGS && rank(item) === 0) {
          const victim = [...this.tags.values()]
            .filter((t) => !isCreated(this.gladys, t.key))
            .sort((a, b) => a.seenAt - b.seenAt)[0];
          if (victim) {
            this.tags.delete(victim.key);
          }
        }
        if (this.tags.size >= MAX_TAGS) {
          this.more += 1;
          continue;
        }
        tag = newTag({ key });
        this.tags.set(key, tag);
      }
      // The instant the gateway last heard the tag, on the clock of Gladys.
      const heardAge = ts !== null ? Math.max(0, gwTime - ts) : 0;
      tag.seenAt = Math.max(tag.seenAt, readAt - heardAge);
      for (const field of fieldsOf({ ...measure, rssi: entry.rssi })) {
        tag.fields.add(field);
      }
      const lastReadAt = tag.lastReadAt;
      tag.lastReadAt = readAt;
      const mark =
        measure.sequence !== null
          ? `s:${measure.sequence}`
          : ts !== null
            ? `t:${ts}`
            : `r:${entry.data.toLowerCase()}`;
      if (tag.sample?.mark === mark) {
        continue;
      }
      // After a restart, the measurement already published keeps the
      // instants it had: its age is never reset by the restart.
      const known = mark === tag.published.mark;
      const firstTs = known && tag.published.markTs !== null ? tag.published.markTs : ts;
      const markAt = known && tag.published.markAt > 0 ? tag.published.markAt : readAt;
      const previous = tag.sample;
      let age;
      if (firstTs !== null && gwTime !== null) {
        age = gwTime - firstTs;
      } else if (previous && lastReadAt !== undefined) {
        // The mark changed since the previous read: measured since then.
        age = readAt - lastReadAt;
      } else {
        // Seen for the first time without the instants of the gateway: it
        // may be the last frame of a tag silent for days. No value.
        age = null;
      }
      // Motion: the movement counter of the frame moved since the previous
      // measurement of the same tag, if that one is at most an hour old
      // (never across a restart: the first measurement gives no motion).
      const motion =
        measure.movement !== null &&
        previous &&
        previous.movement !== null &&
        age !== null &&
        this.isFresh(previous, readAt)
          ? Number(measure.movement !== previous.movement)
          : null;
      tag.sample = {
        values: valuesOf({ ...measure, rssi: entry.rssi, motion }),
        mark,
        firstTs,
        markAt,
        age: age === null ? null : Math.max(0, age),
        readAt,
        movement: measure.movement,
      };
    }
    // A tag neither heard for a week nor created in Gladys leaves the list
    // (a neighbour's tag that passed by).
    for (const [key, tag] of this.tags) {
      if (readAt - tag.seenAt > FORGET_AFTER && !isCreated(this.gladys, key)) {
        this.tags.delete(key);
      }
    }
  }

  /** The age of a measurement now, on the clock of the gateway. */
  ageOf(sample, now = this.now()) {
    return sample.age === null ? Infinity : sample.age + Math.max(0, now - sample.readAt);
  }

  /** A failed read: refusal, pause or a passing failure (retried at the interval). */
  failed(error, { current, secret }) {
    const at = this.now();
    if (!current) {
      // Disconnected (or reconfigured) meanwhile: nothing is published and no
      // status is set, but a pause or a refusal of the settings still
      // configured is kept.
      if ((error.kind === 'limited' || error.kind === 'busy') && secret === this.secret) {
        this.recordBusy(error, at);
      }
      if (error.kind === 'refused' && secret === this.secret) {
        this.recordRefusal(secret);
      }
      return;
    }
    this.error = error.kind;
    if (error.kind === 'refused') {
      this.recordRefusal(secret);
    } else if (error.kind === 'limited' || error.kind === 'busy') {
      this.recordBusy(error, at);
    }
    this.logger.warn(`Ruuvi Gateway: ${this.scrub(error)}`);
  }

  /**
   * Final: no periodic read until the address or the key change (or the
   * test button, one try once the interval has passed). The marker of the
   * refused settings is kept only while they are refused.
   */
  recordRefusal(secret) {
    this.error = 'refused';
    this.store.update({ refused: true }, secret);
  }

  /** A 429 / 5xx: Retry-After, else 5 minutes doubling; 1 minute to 6 hours. */
  recordBusy(error, at) {
    const streak = this.store.get().streak + 1;
    const pause = clamp(
      error.retryAfterMs ?? BUSY_BASE * 2 ** Math.min(streak - 1, 10),
      BUSY_MIN,
      BUSY_MAX,
    );
    this.store.update({ streak, pausedUntil: at + pause });
  }

  /** The tags as kept under /data (nothing secret). */
  serialize() {
    return [...this.tags.values()].map((t) => ({
      key: t.key,
      fields: [...t.fields],
      mark: t.published.mark,
      markTs: t.published.markTs,
      markAt: t.published.markAt,
      seenAt: t.seenAt,
    }));
  }

  // --- Gladys devices and states --------------------------------------------------

  devices() {
    const devices = [];
    for (const tag of this.tags.values()) {
      const device = deviceOf(this.gladys, { tagKey: tag.key, name: tag.name, fields: tag.fields });
      if (device.features.length > 0) {
        devices.push(device);
      }
    }
    return devices;
  }

  async publish() {
    await this.publishDiscovered();
    await this.publishStates();
  }

  /** The Discovery tab, published again only when it changed. */
  async publishDiscovered({ force = false } = {}) {
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  /** A measurement at most one hour old (on the clock of the gateway). */
  isFresh(sample, now = this.now()) {
    return Boolean(sample) && this.ageOf(sample, now) <= STALE;
  }

  /**
   * The values of the created features, from each tag's last measurement
   * (its signal goes with it, never alone). A measurement is told apart by
   * its mark (never by an instant converted between clocks):
   *
   * - a measurement is handed to Gladys once per feature; one already
   *   published (its mark kept under /data, so also across a restart) is
   *   never sent again, but to a feature created since (then dated);
   * - a new measurement at most `recentMs()` old is sent as current; older,
   *   up to one hour, it is sent dated (`created_at`: no scene fires); older
   *   than one hour, never.
   *
   * So a tag that stops measuring never looks alive: nothing about it is
   * sent until it measures again. The core accepts 300 states per minute:
   * past STATES_PER_MINUTE in the last minute, the rest waits in a backlog
   * (the newest value of each feature) sent as the minute frees room.
   */
  async publishStates() {
    const created = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        created.add(feature.external_id);
      }
    }
    // The features created when the process first published: a feature
    // outside of it was created since (a value already in Gladys for the
    // others is never sent again).
    if (this.baseline === undefined) {
      this.baseline = new Set(created);
    }
    if (created.size === 0) {
      return;
    }
    const now = this.now();
    let advanced = false;
    for (const tag of this.tags.values()) {
      const sample = tag.sample;
      if (!sample || !this.isFresh(sample, now)) {
        continue;
      }
      const isNew = sample.mark !== tag.published.mark;
      // The instant of the measurement, on the clock of Gladys: kept with
      // each waiting state, so the state is judged again when it leaves.
      const measuredAt = now - this.ageOf(sample, now);
      let sent = false;
      for (const state of statesOf(this.gladys, { tagKey: tag.key, values: sample.values })) {
        const id = state.device_feature_external_id;
        if (!created.has(id) || this.pushed.get(id) === sample.mark) {
          continue;
        }
        if (!isNew && this.baseline.has(id)) {
          // Already published (before a restart, or before this feature was
          // seen): never again.
          continue;
        }
        this.pushed.set(id, sample.mark);
        // A measurement already published elsewhere goes dated to a feature
        // created since.
        this.backlog.set(id, { state, measuredAt, dated: !isNew });
        sent = true;
      }
      if (sent && isNew) {
        tag.published = { mark: sample.mark, markTs: sample.firstTs, markAt: sample.markAt };
        advanced = true;
      }
    }
    if (advanced) {
      // Written with the next allowed write (at most once per minute).
      this.store.update({ tags: this.serialize() }, undefined, { defer: true });
    }
    await this.flushStates();
  }

  /** Room left in the per-minute budget. */
  stateBudget() {
    const now = this.now();
    this.sentLog = this.sentLog.filter(([t]) => now - t < 60_000);
    return STATES_PER_MINUTE - this.sentLog.reduce((sum, [, n]) => sum + n, 0);
  }

  /**
   * Send what waits, within the budget. Each state is judged when it
   * leaves, whatever the time it waited (a full budget, a failed publication,
   * a disconnection of hours): more than an hour old, it is dropped; older
   * than `recentMs()`, it goes dated (`created_at`), never as current.
   */
  async flushStates() {
    const now = this.now();
    for (const [id, item] of this.backlog) {
      if (now - item.measuredAt > STALE) {
        this.backlog.delete(id);
      }
    }
    if (this.backlog.size === 0) {
      return;
    }
    const budget = this.stateBudget();
    if (budget <= 0) {
      this.scheduleFlush();
      return;
    }
    const items = [...this.backlog.entries()].slice(0, budget);
    for (const [id] of items) {
      this.backlog.delete(id);
    }
    const batch = items.map(([, item]) =>
      item.dated || now - item.measuredAt > this.recentMs()
        ? { ...item.state, created_at: new Date(item.measuredAt).toISOString() }
        : item.state,
    );
    // The batch is reserved in the budget BEFORE the await: a flush running
    // meanwhile (a test button, a created device) sees the room already taken.
    const entry = [this.now(), batch.length];
    this.sentLog.push(entry);
    try {
      const result = await this.gladys.publishChangedStates(batch, { heartbeat: HEARTBEAT });
      // Only what was really sent counts (unchanged values are skipped).
      entry[1] = Number.isFinite(result?.count) ? result.count : batch.length;
    } catch (err) {
      entry[1] = 0;
      this.logger.warn(`Publishing the states failed: ${err.message}`);
      // Sent again later (judged again then), unless a newer value came in
      // meanwhile.
      for (const [id, item] of items) {
        if (!this.backlog.has(id)) {
          this.backlog.set(id, item);
        }
      }
      this.scheduleFlush(60_000);
      return;
    }
    if (this.backlog.size > 0) {
      this.scheduleFlush();
    }
  }

  /** Flush again when the oldest send of the minute expires. */
  scheduleFlush(wait) {
    if (this.flushTimer !== undefined) {
      return;
    }
    const oldest = this.sentLog[0]?.[0];
    const delay =
      wait ??
      (oldest !== undefined ? Math.max(1_000, 60_000 - (this.now() - oldest) + 100) : 1_000);
    const generation = this.generation;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      if (generation === this.generation) {
        this.flushStates().catch((err) => this.logger.warn(`Flush failed: ${err.message}`));
      }
    }, delay);
  }

  // --- Status ------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  withNotes(text) {
    const notes = [];
    if (this.error === 'refused') {
      notes.push(this.config.token ? T.refusedKey : T.refusedNoKey);
    }
    if (this.more > 0) {
      notes.push(T.moreTags(this.more, MAX_TAGS));
    }
    if (Object.keys(this.ignored).length > 0) {
      notes.push(T.notDecoded(this.ignored));
    }
    if (notes.length === 0) {
      return text;
    }
    return {
      en: `${text.en} ${notes.map((n) => `${n.en.replace(/\.$/, '')}.`).join(' ')}`,
      fr: `${text.fr} ${notes.map((n) => `${n.fr.replace(/\.$/, '')}.`).join(' ')}`,
    };
  }

  /** What has no value, and why: [{ name, kind }]. */
  failing() {
    const list = [];
    if (this.error) {
      list.push({ name: 'Ruuvi Gateway', kind: this.error });
    }
    const now = this.now();
    for (const tag of this.tags.values()) {
      if (!this.isFresh(tag.sample, now) && !this.error) {
        list.push({ name: tag.name, kind: tag.sample?.age === null ? 'waiting' : 'stale' });
      }
    }
    return list;
  }

  configMessage() {
    const { config } = this;
    if (this.secret) {
      return null;
    }
    if (config.invalidHost) {
      return T.invalidHost;
    }
    if (config.invalidToken) {
      return T.invalidToken(config.token.length);
    }
    return T.notConfigured;
  }

  async refreshStatus() {
    const missing = this.configMessage();
    if (missing) {
      return this.setStatus(false, missing);
    }
    const now = this.now();
    const failing = this.failing();
    const anyValue = [...this.tags.values()].some((t) => this.isFresh(t.sample, now));
    const text = T.ok({
      tags: this.tags.size,
      interval: this.config.pollMinutes,
      stopped: this.error === 'refused',
      failing,
    });
    return this.setStatus(
      this.error !== 'refused' && (anyValue || failing.length === 0),
      this.withNotes(text),
    );
  }

  // --- Configuration screen button -------------------------------------------------

  tagLine(tag, lang) {
    const colon = lang === 'fr' ? ' :' : ':';
    const now = this.now();
    const parts = [];
    const add = (field, label, unit, digits) => {
      const value = tag.sample?.values?.[field];
      if (typeof value === 'number') {
        parts.push(`${label} ${numberText(value, lang, digits)}${unit}`);
      }
    };
    if (!this.isFresh(tag.sample, now)) {
      const why = tag.sample
        ? reason(tag.sample.age === null ? 'waiting' : 'stale')[lang]
        : lang === 'fr'
          ? 'pas encore lu depuis le démarrage'
          : 'not read since the start';
      return `- ${tag.name}${colon} ${why}`;
    }
    add('temperature', lang === 'fr' ? 'température' : 'temperature', ' °C', 2);
    add('humidity', lang === 'fr' ? 'humidité' : 'humidity', ' %', 1);
    add('pressure', lang === 'fr' ? 'pression' : 'pressure', ' hPa', 1);
    add('battery_voltage', lang === 'fr' ? 'pile' : 'battery', ' V', 3);
    const minutes = Math.round(this.ageOf(tag.sample, now) / 60_000);
    parts.push(lang === 'fr' ? `mesure d'il y a ${minutes} min` : `measured ${minutes} min ago`);
    return `- ${tag.name}${colon} ${parts.join(', ')}`;
  }

  gatewayLines(lang) {
    const colon = lang === 'fr' ? ' :' : ':';
    const saved = this.store.get();
    const name = saved.gwMac ? `Ruuvi Gateway ${macText(saved.gwMac)}` : 'Ruuvi Gateway';
    const head = [];
    if (this.error) {
      head.push(reason(this.error)[lang]);
      if (saved.pausedUntil > this.now()) {
        head.push(T.pausedUntil(saved.pausedUntil)[lang]);
      }
    } else {
      head.push(lang === 'fr' ? `${this.tags.size} capteur(s)` : `${this.tags.size} tag(s)`);
    }
    head.push(T.nextRead(this.nextRead())[lang]);
    const lines = [`${name}${colon} ${head.join(', ')}`];
    for (const tag of this.tags.values()) {
      lines.push(this.tagLine(tag, lang));
    }
    return lines;
  }

  async testConnection() {
    const missing = this.configMessage();
    if (missing) {
      return missing;
    }
    // Gladys waits for the answer: past TEST_DEADLINE, the last values are
    // shown (a read still running finishes in the background).
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TEST_DEADLINE);
    });
    try {
      await Promise.race([this.tick({ manual: true }), timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
    const answer = {
      en: this.gatewayLines('en').join('\n'),
      fr: this.gatewayLines('fr').join('\n'),
    };
    await this.publish();
    await this.refreshStatus();
    return this.withNotes(answer);
  }
}
