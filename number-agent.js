import { normalizeKenyanPhone } from './phone.js';

const OCR_REPLACEMENTS = new Map([
  ['O', '0'], ['Q', '0'], ['D', '0'],
  ['I', '1'], ['L', '1'], ['l', '1'],
  ['S', '5'], ['B', '8'], ['G', '6'], ['Z', '2']
]);

const PHONE_CANDIDATE = /(?:\+?254|0|[2Zz]S?4)(?:[\s().\-]*[0-9A-Za-z]){9}/gi;

function cleanCandidate(candidate) {
  return [...candidate].map(character => OCR_REPLACEMENTS.get(character) || character).join('');
}

export function decodeKenyanPhones(text) {
  const numbers = new Set();
  let invalidCount = 0;
  let duplicateCount = 0;
  const source = String(text || '').replace(/[\u2010-\u2015]/g, '-');

  for (const match of source.matchAll(PHONE_CANDIDATE)) {
    const candidate = match[0];
    if (!/\d/.test(candidate)) continue;
    const normalized = normalizeKenyanPhone(cleanCandidate(candidate));
    if (normalized) {
      if (numbers.has(normalized)) duplicateCount += 1;
      numbers.add(normalized);
    } else if (candidate.replace(/\D/g, '').length >= 9) {
      invalidCount += 1;
    }
  }

  return { numbers: [...numbers], invalidCount, duplicateCount };
}