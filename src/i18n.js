// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button), en and fr.
// -----------------------------------------------------------------------------

/** "2026-10-20T18:00:00Z" -> "18:00 UTC". */
export const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why the gateway or a tag has no fresh value. */
export const REASONS = {
  refused: { en: 'access refused', fr: 'accès refusé' },
  limited: { en: 'too many requests (pause)', fr: 'trop de requêtes (pause)' },
  busy: { en: 'gateway unavailable (pause)', fr: 'passerelle indisponible (pause)' },
  failed: { en: 'no answer', fr: 'pas de réponse' },
  invalid: {
    en: 'not an answer of a Ruuvi Gateway',
    fr: "réponse qui n'est pas celle d'une Ruuvi Gateway",
  },
  stale: { en: 'no recent measurement', fr: 'pas de mesure récente' },
};

export const reason = (kind) => REASONS[kind] ?? REASONS.failed;

/** Names of the data formats not decoded, as Ruuvi names them. */
const FORMAT_NAMES = {
  'format:6': 'Ruuvi Air (6)',
  'format:225': 'Ruuvi Air (E1)',
  'format:8': '8',
  'format:4': '4 (URL)',
  'format:2': '2 (URL)',
};

const formatName = (why) => FORMAT_NAMES[why] ?? (why.startsWith('format:') ? why.slice(7) : null);

export const T = {
  notConfigured: {
    en: 'Enter the address of your Ruuvi Gateway on the local network (for example 192.168.1.50).',
    fr: "Saisissez l'adresse de votre Ruuvi Gateway sur le réseau local (par exemple 192.168.1.50).",
  },
  invalidHost: {
    en: 'Address of the gateway not valid: a host name or an IP address, an optional port (no path, no user name, no multicast or broadcast address). Type it again.',
    fr: "Adresse de la passerelle non valide : un nom d'hôte ou une adresse IP, un port facultatif (ni chemin, ni nom d'utilisateur, ni adresse de multidiffusion ou de diffusion). Saisissez-la à nouveau.",
  },
  invalidToken: (n) => ({
    en: `API key not valid (${n} characters): it holds a space or a character that is not printable ASCII, or it is longer than 256 characters. It is not shown back. Type it again.`,
    fr: `Clé d'API non valide (${n} caractères) : elle contient une espace ou un caractère qui n'est pas de l'ASCII imprimable, ou elle dépasse 256 caractères. Elle n'est pas réaffichée. Saisissez-la à nouveau.`,
  }),
  refusedNoKey: {
    en: 'The gateway asks for a key: on its Access settings page, turn on the read-only access with an API key (bearer) and enter that key here. No new try until you change the address or the key (or press the test button).',
    fr: "La passerelle demande une clé : sur sa page Paramètres d'accès, activez l'accès en lecture seule par clé d'API (bearer) et saisissez cette clé ici. Plus aucun essai tant que vous ne changez pas l'adresse ou la clé (ou que vous n'appuyez pas sur le bouton de test).",
  },
  refusedKey: {
    en: 'The gateway refused the API key: no new try until you change the address or the key (or press the test button). Check the read-only API key on the Access settings page of the gateway.',
    fr: "La passerelle a refusé la clé d'API : plus aucun essai tant que vous ne changez pas l'adresse ou la clé (ou que vous n'appuyez pas sur le bouton de test). Vérifiez la clé d'API en lecture seule sur la page Paramètres d'accès de la passerelle.",
  },
  moreTags: (n, max) => ({
    en: `${n} more tag(s) heard by the gateway not read (at most ${max}).`,
    fr: `${n} autre(s) capteur(s) entendu(s) par la passerelle non lu(s) (${max} au plus).`,
  }),
  notDecoded: (counts) => {
    const named = [...new Set(Object.keys(counts).map(formatName).filter(Boolean))];
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    const list = named.length > 0 ? ` (${named.join(', ')})` : '';
    return {
      en: `${n} Ruuvi frame(s) not decoded${named.length > 0 ? `: data format${list}` : ''}.`,
      fr: `${n} trame(s) Ruuvi non décodée(s)${named.length > 0 ? ` : format de données${list}` : ''}.`,
    };
  },
  nextRead: (at) => ({
    en: `next read possible at ${utcTime(at)}`,
    fr: `prochaine lecture possible à ${utcTime(at)}`,
  }),
  pausedUntil: (until) => ({
    en: `paused until ${utcTime(until)}`,
    fr: `en pause jusqu'à ${utcTime(until)}`,
  }),
  /** The connected status: what is read, how often, and what fails. */
  ok: ({ tags, interval, failing = [] }) => {
    let en = `${tags} RuuviTag(s) through the Ruuvi Gateway, read every ${interval} min.`;
    let fr = `${tags} RuuviTag(s) via la Ruuvi Gateway, lu(s) toutes les ${interval} min.`;
    if (failing.length > 0) {
      en += ` Without value: ${failing.map((f) => `${f.name} (${reason(f.kind).en})`).join(', ')}.`;
      fr += ` Sans valeur : ${failing.map((f) => `${f.name} (${reason(f.kind).fr})`).join(', ')}.`;
    }
    return { en, fr };
  },
};
