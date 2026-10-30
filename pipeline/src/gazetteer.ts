// Domain vocabularies and code lists (all offline, bundled).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export const DOMAIN_WORDS = new Set<string>([
  'NIMR', 'LLC', 'L.L.C', 'GMBH', 'PTY', 'LTD', 'FZE', 'FZCO', 'FZ', 'INC', 'CORP', 'KG',
  'AUTOMOTIVE', 'TAWAZUN', 'AJBAN', 'AJBAAN', 'DHABI', 'ABU', 'JEBEL', 'ALI', 'EMIRATES', 'ARAB', 'UNITED', 'UAE',
  'INDUSTRIAL', 'PARK', 'ROAD', 'WAREHOUSE', 'CENTRAL', 'ZONE', 'FREIGHT', 'LOGISTICS', 'WORLDWIDE', 'SERVICES',
  'SCHROTH', 'SAFETY', 'PRODUCTS', 'KNOTT', 'RADEL', 'KRAMSACH', 'CARBIDE', 'TOOLS', 'TRADING', 'INOAC', 'IRC',
  'KLN', 'KLNME', 'KERRY', 'PRISM', 'GLOBAL', 'ALLCARGO', 'FEDEX', 'DHL', 'ARAMEX', 'MAERSK', 'MSC', 'CMA', 'CGM', 'HAPAG', 'LLOYD', 'COSCO', 'EVERGREEN', 'ONE',
  'AWB', 'HAWB', 'MAWB', 'BL', 'HBL', 'MBL', 'FBL', 'KGS', 'CBM', 'PCS', 'PKG', 'PKGS', 'CTNS', 'PALLET', 'PALLETS',
  'EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'EXWORKS',
  'CONSIGNEE', 'CONSIGNOR', 'SHIPPER', 'NOTIFY', 'VESSEL', 'VOYAGE', 'NEGOTIABLE', 'WAYBILL', 'TELEX', 'RELEASE',
  'PREPAID', 'COLLECT', 'AVE', 'NW', 'STREET', 'FORT', 'LAUDERDALE', 'FLORIDA', 'SECAUCUS', 'PENHORN', 'UNIT',
  'MENDELSSOHN', 'JAKARTA', 'INDONESIA', 'HAYAM', 'WURUK', 'WISMA', 'RUN', 'FLAT', 'PEDAL', 'PAD',
  'TARIFFNUMBER', 'HSCODE', 'NETWEIGHT', 'GROSSWEIGHT',
]);

export const INCOTERMS: Record<string, string> = {
  EXW: 'EXW', EXWORKS: 'EXW', 'EX WORKS': 'EXW', 'EX-WORKS': 'EXW', FCA: 'FCA', FAS: 'FAS', FOB: 'FOB', CFR: 'CFR', 'C&F': 'CFR', CNF: 'CFR',
  CIF: 'CIF', CPT: 'CPT', CIP: 'CIP', DAP: 'DAP', DPU: 'DPU', DAT: 'DPU', DDP: 'DDP', DDU: 'DAP',
};

/** Client master data: known parties. Matching ignores spaces/punctuation, so OCR space loss does not matter. */
export const KNOWN_PARTIES: { name: string; aliases?: string[]; role?: string }[] = [
  { name: 'NIMR AUTOMOTIVE LLC', aliases: ['NIMR AUTOMOTVE LLC', 'NIMR Automotive LLC'], role: 'consignee' },
  { name: 'Seal N Devices (Pty) Ltd', aliases: ["SEAL 'N DEVICES (PTY) LTD", 'Seal N Devices PTY LTD'] },
  { name: 'Schroth Safety Products LLC' },
  { name: 'Knott GmbH' },
  { name: 'Radél (Pty) Ltd', aliases: ['Radel (Pty) Ltd'] },
  { name: 'CTT-Carbide Tools Trading GmbH' },
  { name: 'PT. IRC Inoac Indonesia', aliases: ['PT IRC INOAC INDONESIA'] },
  { name: 'KLN Freight Middle East AUH L.L.C.', aliases: ['KLNME FREIGHT SERVICES LLC', 'KLN FREIGHT MIDDLE EAST AUH L.L.C.'] },
  { name: 'A.J. Worldwide Services Inc' },
  { name: 'Gebrueder Weiss GmbH' },
  { name: 'ACS Logistics GmbH & Co KG' },
];

const squash = (s: string) => s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');

export function matchParty(text: string): { name: string; score: number } | null {
  // EVAL_COLD_START=1 simulates a sender's first upload: no master data, no learned layouts.
  if (process.env.EVAL_COLD_START === '1') return null;
  const t = squash(text);
  if (t.length < 4) return null;
  let best: { name: string; score: number } | null = null;
  for (const p of KNOWN_PARTIES) {
    for (const cand of [p.name, ...(p.aliases ?? [])]) {
      const c = squash(cand);
      let score = 0;
      if (t.includes(c)) score = 1;
      else score = 1 - levenshtein(t.slice(0, c.length + 2), c) / Math.max(c.length, 1);
      if (!best || score > best.score) best = { name: p.name, score };
    }
  }
  return best && best.score >= 0.8 ? best : null;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// --- Airports (IATA) -------------------------------------------------------
type Airport = { iata: string; city: string; name: string; country: string };
let AIRPORTS: Airport[] | null = null;
export function airports(): Airport[] {
  if (!AIRPORTS) {
    const raw: any[] = require('@nwpr/airport-codes/dist/airports.json');
    AIRPORTS = raw.filter((a) => a.iata && a.iata.length === 3 && a.type === 'airport').map((a) => ({ iata: a.iata, city: a.city ?? '', name: a.name ?? '', country: a.country ?? '' }));
  }
  return AIRPORTS;
}
const CITY_ALIASES: Record<string, string> = { MUENCHEN: 'MUC', MUNCHEN: 'MUC', MUNICH: 'MUC', 'ABU DHABI': 'AUH', DUBAI: 'DXB', 'DUBAI WORLD CENTRAL': 'DWC', MIAMI: 'MIA', SHARJAH: 'SHJ', FRANKFURT: 'FRA', JAKARTA: 'CGK', JOHANNESBURG: 'JNB', VIENNA: 'VIE', WIEN: 'VIE' };
export function resolveAirport(text: string): { iata: string; city: string } | null {
  const t = text.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const [k, v] of Object.entries(CITY_ALIASES)) if (t.includes(k) || t.replace(/ /g, '').includes(k.replace(/ /g, ''))) return { iata: v, city: k };
  const ap = airports();
  if (/^[A-Z]{3}$/.test(t)) { const a = ap.find((x) => x.iata === t); if (a) return { iata: a.iata, city: a.city }; }
  const byCity = ap.find((x) => x.city.toUpperCase() === t);
  return byCity ? { iata: byCity.iata, city: byCity.city } : null;
}
export function isIata(code: string): boolean { return airports().some((a) => a.iata === code); }

// --- Seaports (subset of UN/LOCODE most relevant to UAE inbound; extend from the full UN/LOCODE CSV) ----
export const PORTS: Record<string, string[]> = {
  AEJEA: ['JEBEL ALI'], AEKHL: ['KHALIFA PORT', 'KHALIFA'], AEAUH: ['ABU DHABI'], AEKLF: ['KHOR AL FAKKAN', 'KHORFAKKAN', 'KHOR FAKKAN'], AESHJ: ['SHARJAH'], AEDXB: ['DUBAI', 'PORT RASHID'], AEFJR: ['FUJAIRAH'],
  ZADUR: ['DURBAN'], ZAJNB: ['JOHANNESBURG'], ZACPT: ['CAPE TOWN'], DEHAM: ['HAMBURG'], DEBRV: ['BREMERHAVEN'], NLRTM: ['ROTTERDAM'], BEANR: ['ANTWERP'],
  SGSIN: ['SINGAPORE'], IDJKT: ['JAKARTA', 'TANJUNG PRIOK'], CNSHA: ['SHANGHAI'], CNNGB: ['NINGBO'], CNSZX: ['SHENZHEN'], INNSA: ['NHAVA SHEVA', 'JAWAHARLAL NEHRU'], INMUN: ['MUNDRA'],
  USMIA: ['MIAMI'], USNYC: ['NEW YORK'], USSAV: ['SAVANNAH'], ITGOA: ['GENOA'], ESVLC: ['VALENCIA'], OMSLL: ['SALALAH'], SAJED: ['JEDDAH'], LKCMB: ['COLOMBO'],
};
export function resolvePort(text: string): { locode: string; name: string } | null {
  const t = text.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const sq = t.replace(/ /g, '');
  let best: { locode: string; name: string; len: number } | null = null;
  for (const [code, names] of Object.entries(PORTS)) for (const n of names) {
    if (t.includes(n) || sq.includes(n.replace(/ /g, ''))) if (!best || n.length > best.len) best = { locode: code, name: n, len: n.length };
  }
  return best ? { locode: best.locode, name: best.name } : null;
}

// --- Countries & currencies -------------------------------------------------
let COUNTRIES: Map<string, string> | null = null;
export function resolveCountry(text: string): string | null {
  if (!COUNTRIES) {
    const ic = require('i18n-iso-countries');
    ic.registerLocale(require('i18n-iso-countries/langs/en.json'));
    ic.registerLocale(require('i18n-iso-countries/langs/de.json'));
    COUNTRIES = new Map();
    for (const lang of ['en', 'de']) {
      const names = ic.getNames(lang, { select: 'all' }) as Record<string, string[]>;
      for (const [code, ns] of Object.entries(names)) for (const n of ns) COUNTRIES.set(n.toUpperCase().replace(/[^A-Z]/g, ''), code);
    }
    for (const [k, v] of Object.entries({ USA: 'US', UNITEDSTATESOFAMERICA: 'US', UK: 'GB', UAE: 'AE', CZECHREPUBLIC: 'CZ', REPUBLICOFSOUTHAFRICA: 'ZA', VEREINIGTEARABISCHEEMIRATE: 'AE' })) COUNTRIES.set(k, v);
  }
  const t = text.toUpperCase().replace(/[^A-Z]/g, '');
  if (COUNTRIES.has(t)) return COUNTRIES.get(t)!;
  if (/^[A-Z]{2}$/.test(t)) return t;
  return null;
}

let CURRENCIES: Set<string> | null = null;
export function isCurrency(code: string): boolean {
  if (!CURRENCIES) CURRENCIES = new Set((require('currency-codes').codes() as string[]));
  return CURRENCIES.has(code);
}
