// -----------------------------------------------------------------------------
// What must survive a restart of the container (a file under /data): the
// instant of the last request to the gateway, the end of a pause (429/5xx),
// whether the API key was refused, the MAC of the gateway and the tags met
// (MAC, the fields they gave, the mark of the last measurement handed to
// Gladys: nothing secret), so a container restarting in a loop never reads
// faster than the interval, never sends a refused key again, never hands a
// measurement to Gladys twice, and the Discovery list is not empty after a
// restart.
//
// The instant of a request is written at most once per minute (WRITE_GAP
// after the previous write, whatever it was; the instant of the write is
// kept in the file): a read waits until such a write is allowed, so the
// instant of its request is always on disk before the request leaves. A
// pause, a refusal, their end or a new tag is written at once (one such
// write per request at most), so a restart never forgets it.
//
// The API key is never written. Only while it is refused, the file keeps a
// marker of the refused address and key: 8 bits of a salted scrypt hash, so
// that after a restart other settings are tried at once. 8 bits single out
// nothing: a key, even a short one, cannot be found back from them (1 key
// in 256 gives the same marker).
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_TAGS, TICK, WRITE_GAP } from './constants.js';
import { featureKeys } from './fields.js';

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  return {
    writes: 0,
    load: () => value,
    save(next) {
      this.writes += 1;
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing or
 * unreadable file is a first start (warned once, without its content); a
 * write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): starting afresh`);
        }
        return undefined;
      }
      if (text.length > 256 * 1024) {
        warnOnce('read', 'State file too large: starting afresh');
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        warnOnce('read', 'State file corrupt: starting afresh');
        return undefined;
      }
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
      }
    },
  };
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const finiteOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The mark of a measurement: `s:<sequence>`, `t:<ms>` or `r:<hex frame>`. */
const MARK = /^(s:\d{1,5}|t:\d{1,14}|r:[0-9a-f]{2,512})$/;

/** A tag read back from the file, or undefined when it does not look right. */
function tagOf(value, now) {
  if (!value || typeof value !== 'object' || !/^[0-9a-f]{12}$/.test(value.key ?? '')) {
    return undefined;
  }
  const allowed = featureKeys();
  const fields = Array.isArray(value.fields)
    ? value.fields.filter((f) => typeof f === 'string' && allowed.has(f)).slice(0, 20)
    : [];
  const mark = typeof value.mark === 'string' && MARK.test(value.mark) ? value.mark : '';
  return {
    key: value.key,
    fields: [...new Set(fields)],
    // The mark of the last measurement handed to Gladys, the instant the
    // gateway first heard it (its clock, ms) and the instant it changed (the
    // clock of Gladys): a measurement not newer is never sent again, also
    // after a restart.
    mark,
    markTs: mark ? finiteOrNull(value.markTs) : null,
    markAt: mark ? Math.min(finite(value.markAt), now) : 0,
    seenAt: Math.min(finite(value.seenAt), now),
  };
}

export class GatewayStore {
  constructor({
    storage = memoryStorage(),
    now = Date.now,
    timers = { setTimeout, clearTimeout },
    maxPause,
    nextReadAt = () => Infinity,
  }) {
    /** When the next periodic read is due (it writes the whole entry). */
    this.nextReadAt = nextReadAt;
    this.storage = storage;
    this.now = now;
    this.timers = timers;
    this.flushTimer = undefined;
    this.dirty = false;
    /** In memory only: the settings last configured, to tell a change. */
    this.secret = undefined;
    const saved = storage.load();
    const valid = saved && typeof saved === 'object' && !Array.isArray(saved);
    const at = now();
    this.salt =
      valid && typeof saved.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt)
        ? saved.salt
        : randomBytes(16).toString('hex');
    // The instant of the last write, never in the future: a restart loop
    // writes no more often than a running process.
    this.writtenAt = valid ? Math.min(finite(saved.writtenAt), at) : 0;
    const entry = valid && saved.gateway && typeof saved.gateway === 'object' ? saved.gateway : {};
    // A time read back is capped (a request never "in the future", a pause
    // never longer than a fresh one): a clock that jumped, or a hand-edited
    // file, never stops the reads for longer.
    this.entry = {
      lastAttemptAt: Math.min(finite(entry.lastAttemptAt), at),
      pausedUntil: Math.min(finite(entry.pausedUntil), at + maxPause),
      streak: Math.min(Math.max(0, Math.floor(finite(entry.streak))), 20),
      refused: entry.refused === true,
      fp: typeof entry.fp === 'string' && /^[0-9a-f]{2}$/.test(entry.fp) ? entry.fp : '',
      gwMac:
        typeof entry.gwMac === 'string' && /^[0-9a-f]{12}$/.test(entry.gwMac) ? entry.gwMac : '',
      tags: Array.isArray(entry.tags)
        ? entry.tags
            .slice(0, MAX_TAGS)
            .map((t) => tagOf(t, at))
            .filter(Boolean)
        : [],
    };
    if (!this.entry.refused) {
      this.entry.fp = '';
    }
  }

  /** The marker of the settings: 8 bits of a salted hash (never the key). */
  fingerprint(secret) {
    return scryptSync(String(secret), `${this.salt}:gateway`, 16).toString('hex').slice(0, 2);
  }

  get() {
    return this.entry;
  }

  /**
   * The saved state for the configured settings (`address\nkey`). Other
   * settings drop the refusal and the instant of the last request (tried at
   * once): told apart in memory while the process runs; after a restart,
   * only a refused pair is known (its marker), so settings changed while the
   * container was stopped wait at most one interval (or, 1 time in 256, the
   * test button). A refusal whose marker is missing is kept (never lifted by
   * guess). Returns `{ entry, changed }`.
   */
  restore(secret) {
    let changed = false;
    if (this.secret !== undefined) {
      changed = this.secret !== secret;
    } else if (this.entry.refused && this.entry.fp) {
      changed = this.entry.fp !== this.fingerprint(secret);
    }
    this.secret = secret;
    if (changed) {
      // A pause (429/5xx) is kept: the gateway may be the same one.
      this.update({ refused: false, fp: '', lastAttemptAt: 0 }, undefined, { defer: true });
    }
    return { entry: this.entry, changed };
  }

  /**
   * Update the entry. A refusal (`refused: true`, with the refused `secret`)
   * keeps the marker of that secret; its end erases it. A change (a pause, a
   * refusal, its end, the tags met: rare events, one per request at most) is
   * written at once, so a restart never forgets it; with `defer` (the
   * instant of a request, a published mark), at the next allowed instant.
   */
  update(changes, secret, { defer = false } = {}) {
    const previous = this.entry;
    const next = { ...previous, ...changes };
    if (changes.refused === true && secret !== undefined) {
      next.fp = this.fingerprint(secret);
    } else if (!next.refused) {
      next.fp = '';
    }
    this.entry = next;
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      if (defer) {
        this.markDirty();
      } else {
        this.dirty = true;
        this.write();
      }
    }
    return next;
  }

  /** The first instant a write is allowed. */
  writableAt() {
    return this.writtenAt + WRITE_GAP;
  }

  canWrite(now = this.now()) {
    return now >= this.writableAt();
  }

  markDirty() {
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer !== undefined) {
      return;
    }
    // A deferred write never takes the slot of a read due before the end of
    // its own gap: it would be armed for the very instant of the next tick
    // and, firing first, push the read one gap later (a read every other
    // interval at 1 minute). It waits until just after that read, which
    // writes the whole entry anyway (and drops this timer).
    const now = this.now();
    const at = this.writableAt();
    const next = this.nextReadAt();
    const target = next <= at + WRITE_GAP ? Math.max(at, next) + TICK + 1_000 : at;
    const delay = Math.max(0, target - now);
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  /** Write the file now if something changed and a write is allowed; returns whether it is on disk. */
  flush({ force = false } = {}) {
    if (!this.dirty) {
      return true;
    }
    if (!force && !this.canWrite()) {
      this.scheduleFlush();
      return false;
    }
    this.write();
    return true;
  }

  write() {
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.writtenAt = this.now();
    this.dirty = false;
    this.storage.save({ salt: this.salt, writtenAt: this.writtenAt, gateway: this.entry });
  }

  /** Stop the pending write (the next start writes what is left). */
  close() {
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}
