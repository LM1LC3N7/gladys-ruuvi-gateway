// -----------------------------------------------------------------------------
// What a RuuviTag measures, and how it lands in Gladys. Pure: no clock, no
// network.
//
// The decoded frame (src/ruuvitag.js) gives °C, %, Pa and V: converted here,
// once, to the units the Gladys core lists for each category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js).
//
// One Gladys device per tag. The feature key is a name of this integration
// (`temperature`, `motion`...), never a field of the frame: it is part of the
// external id, so it never changes.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE } from './constants.js';

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A finite number, or null (never NaN, never undefined). */
export const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const map = (value, fn) => (value === null ? null : fn(value));

// --- Kinds: Gladys category, type, unit, bounds, rounding ---------------------------
// Only the units the core lists for the category. The core lists no unit
// for a battery voltage nor a radio signal in dBm: `unknown` sensors, the
// unit in their name (as the approved SensorPush module does).

const KINDS = {
  temperature: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -60,
    max: 100,
    convert: (v) => round(v, 2),
  },
  humidity: {
    category: CAT.HUMIDITY_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    convert: (v) => round(v, 1),
  },
  pressure: {
    category: CAT.PRESSURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.HECTO_PASCAL,
    min: 500,
    max: 1155,
    convert: (v) => round(v, 1),
  },
  motion: {
    category: CAT.MOTION_SENSOR,
    type: TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
    convert: (v) => v,
  },
  voltage: {
    category: CAT.UNKNOWN,
    type: TYPES.SENSOR.DECIMAL,
    min: 0,
    max: 5,
    convert: (v) => round(v, 3),
  },
  signal: {
    category: CAT.UNKNOWN,
    type: TYPES.SENSOR.INTEGER,
    min: -150,
    max: 20,
    convert: (v) => Math.round(v),
  },
};

/**
 * [feature key, kind, feature name, read(measure)]: the order of the
 * features in Gladys. `measure` is a decoded frame plus `rssi` (from the
 * gateway) and `motion` (0 or 1, from two measurements in a row, see app.js).
 */
export const TABLE = [
  ['temperature', 'temperature', 'Temperature', (m) => num(m.temperature)],
  ['humidity', 'humidity', 'Humidity', (m) => num(m.humidity)],
  ['pressure', 'pressure', 'Pressure', (m) => map(num(m.pressure), (pa) => pa / 100)],
  ['motion', 'motion', 'Motion', (m) => (m.motion === 0 || m.motion === 1 ? m.motion : null)],
  ['battery_voltage', 'voltage', 'Battery voltage (V)', (m) => num(m.voltage)],
  ['signal', 'signal', 'Signal (dBm)', (m) => num(m.rssi)],
];

const KEYS = new Set(TABLE.map(([key]) => key));

/** Every feature key (the fields kept under /data are checked against it). */
export const featureKeys = () => new Set(KEYS);

/**
 * The fields a measurement of this format can give, so the device has its
 * features from the first frame (motion needs a movement counter).
 */
export function fieldsOf(measure) {
  const fields = new Set();
  for (const [key, , , read] of TABLE) {
    if (key === 'motion') {
      if (num(measure.movement) !== null) {
        fields.add(key);
      }
    } else if (read(measure) !== null) {
      fields.add(key);
    }
  }
  return fields;
}

/**
 * The usable values of a measurement: converted, rounded, within the bounds.
 * A value out of the bounds is left out, never clamped into a false reading.
 */
export function valuesOf(measure) {
  const values = {};
  for (const [key, kindName, , read] of TABLE) {
    const raw = read(measure ?? {});
    if (raw === null || !Number.isFinite(raw)) {
      continue;
    }
    const kind = KINDS[kindName];
    const value = kind.convert(raw);
    if (Number.isFinite(value) && value >= kind.min && value <= kind.max) {
      values[key] = value;
    }
  }
  return values;
}

// --- Gladys devices and states ------------------------------------------------------

const idsOf = (gladys, tagKey) => gladys.externalIds(DEVICE_TYPE, tagKey);

/** The features of a device as the user created it (gladys.devices). */
export function createdFeatures(gladys, tagKey) {
  const ids = idsOf(gladys, tagKey);
  const device = (gladys.devices ?? []).find((d) => d.external_id === ids.device);
  return device?.features ?? [];
}

/** Whether the device of a tag is created in Gladys. */
export const isCreated = (gladys, tagKey) =>
  (gladys.devices ?? []).some((d) => d.external_id === idsOf(gladys, tagKey).device);

const featureOf = (ids, key, kindName, name) => {
  const kind = KINDS[kindName];
  return {
    name,
    external_id: ids.feature(key),
    category: kind.category,
    type: kind.type,
    ...(kind.unit ? { unit: kind.unit } : {}),
    min: kind.min,
    max: kind.max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
};

/**
 * The Gladys device of a tag: every feature it has ever given, plus every
 * feature of the device already created (so a measure missing for a while,
 * or a field this version no longer knows, never removes a feature: the core
 * would mark the device as changed and "Update" would drop its history).
 */
export function deviceOf(gladys, { tagKey, name, fields }) {
  const ids = idsOf(gladys, tagKey);
  const created = createdFeatures(gladys, tagKey);
  const createdIds = new Set(created.map((f) => f.external_id));
  const features = TABLE.filter(([key]) => fields.has(key) || createdIds.has(ids.feature(key))).map(
    ([key, kindName, featureName]) => featureOf(ids, key, kindName, featureName),
  );
  const prefix = `${ids.device}:`;
  for (const feature of created) {
    const key = String(feature.external_id ?? '').startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : '';
    if (key && !KEYS.has(key)) {
      features.push({
        name: feature.name,
        external_id: feature.external_id,
        category: feature.category,
        type: feature.type,
        ...(feature.unit ? { unit: feature.unit } : {}),
        min: feature.min,
        max: feature.max,
        read_only: true,
        has_feedback: false,
        keep_history: feature.keep_history !== false,
      });
    }
  }
  return {
    name,
    external_id: ids.device,
    // The integration reads the gateway at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features,
  };
}

/** The states of the values of a tag, for the publishStates format. */
export function statesOf(gladys, { tagKey, values }) {
  const ids = idsOf(gladys, tagKey);
  return TABLE.filter(([key]) => num(values?.[key]) !== null).map(([key]) => ({
    device_feature_external_id: ids.feature(key),
    state: values[key],
  }));
}
