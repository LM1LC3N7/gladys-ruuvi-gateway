// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  poll_interval: 2,
};

const number = (value, fallback, min, max) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, Math.round(value)));
  }
  // A string counts only when it is digits (`Number('')` is 0: an empty
  // field is the default, never the minimum).
  if (typeof value === 'string' && /^\s*\d{1,6}\s*$/.test(value)) {
    return Math.min(max, Math.max(min, Number(value)));
  }
  return fallback;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * An IPv4 address that is a unicast address of a host: never 0.0.0.0/8,
 * a multicast (224/4), a reserved or broadcast (240/4, 255.255.255.255).
 */
function ipv4Ok(text) {
  const m = IPV4.exec(text);
  if (!m) {
    return null;
  }
  const texts = m.slice(1);
  const parts = texts.map(Number);
  // 010.1.1.1 is ambiguous (octal for some tools): a leading zero is refused.
  if (parts.some((p) => p > 255) || texts.some((p) => p.length > 1 && p.startsWith('0'))) {
    return false;
  }
  return parts[0] !== 0 && parts[0] < 224;
}

/** An IPv6 address (in brackets in the URL): never unspecified nor multicast. */
function ipv6Ok(text) {
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(text) || !text.includes(':')) {
    return false;
  }
  try {
    const host = new URL(`http://[${text}]/`).hostname;
    return host !== '[::]' && !/^\[ff/i.test(host);
  } catch {
    return false;
  }
}

/**
 * The address of the gateway as typed -> `{ base, label }` or null when it
 * is not valid. Taken: a host name or an address, an optional port, an
 * optional `http://` or `https://` in front and a `/` at the end. Refused:
 * a path, a query, a user name, a space or a control character (nothing is
 * sent then).
 */
export function parseAddress(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  let text = raw.trim();
  if (text.length === 0 || text.length > 300 || /[^\x21-\x7e]/.test(text)) {
    return null;
  }
  let scheme = 'http';
  const s = /^(https?):\/\//i.exec(text);
  if (s) {
    scheme = s[1].toLowerCase();
    text = text.slice(s[0].length);
  }
  text = text.replace(/\/$/, '');
  if (/[/?#@\\]/.test(text)) {
    return null;
  }
  let host;
  let port;
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (v6) {
    if (!ipv6Ok(v6[1])) {
      return null;
    }
    host = `[${v6[1].toLowerCase()}]`;
    port = v6[2] ?? '';
  } else {
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(text);
    if (!m) {
      return null;
    }
    host = m[1].toLowerCase();
    port = m[2] ?? '';
    const v4 = ipv4Ok(host);
    if (v4 === false || (v4 === null && (!HOSTNAME.test(host) || /^[\d.]+$/.test(host)))) {
      return null;
    }
  }
  if (port !== '' && (Number(port) < 1 || Number(port) > 65535)) {
    return null;
  }
  const authority = port ? `${host}:${Number(port)}` : host;
  return { base: `${scheme}://${authority}`, label: authority };
}

/** The read-only API key: printable ASCII without space, bounded. */
const tokenOk = (token) => token === '' || (token.length <= 256 && /^[!-~]+$/.test(token));

/** The address of the gateway, its read-only API key and the interval. */
export function normalizeConfig(raw = {}) {
  const hostText = typeof raw.host === 'string' ? raw.host.trim() : '';
  // An API key holds no space: spaces around it are a bad copy.
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  const address = hostText ? parseAddress(hostText) : null;
  return {
    hostGiven: hostText !== '',
    address,
    token,
    // An invalid address or key is refused at once and never sent; it is
    // never shown back either (a key may have been pasted in the wrong field).
    invalidHost: hostText !== '' && !address,
    invalidToken: !tokenOk(token),
    pollMinutes: number(raw.poll_interval, DEFAULT_CONFIG.poll_interval, 1, 60),
  };
}

/** The gateway is configured: a valid address and, if given, a valid key. */
export const isConfigured = (config) => Boolean(config.address) && !config.invalidToken;
