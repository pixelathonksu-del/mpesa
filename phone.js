const PHONE_TOKEN = /(?:\+?254|0)(?:[\s().-]*\d){9}/g;

export function normalizeKenyanPhone(value) {
  const digits = String(value).replace(/\D/g, '');
  let normalized = digits;
  if (digits.length === 10 && digits.startsWith('0')) normalized = `254${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('254')) normalized = digits;
  if (digits.length === 12 && digits.startsWith('+254')) normalized = digits;
  if (!/^254[17]\d{8}$/.test(normalized)) return null;
  return normalized;
}

export function extractKenyanPhones(text) {
  const detected = new Set();
  let duplicateCount = 0;
  const invalid = [];
  for (const match of String(text).matchAll(PHONE_TOKEN)) {
    const candidate = match[0];
    const normalized = normalizeKenyanPhone(candidate);
    if (normalized) {
      if (detected.has(normalized)) duplicateCount += 1;
      detected.add(normalized);
    }
    else if (candidate.replace(/\D/g, '').length >= 9) invalid.push(candidate);
  }
  return { numbers: [...detected], invalidCount: invalid.length, duplicateCount };
}

export function maskPhone(phone) {
  return `${phone.slice(0, 6)}****${phone.slice(-2)}`;
}