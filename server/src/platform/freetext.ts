import type { FreeTextWarning } from '../types.ts';

/**
 * Free text is where personal data sneaks in. Gameday Command stores no CJI
 * and no identity of any member of the public (research 06 §2.1), so every
 * free-text field is checked for the obvious shapes — an email, a phone
 * number, a plate, an SSN, a date of birth, a case number, "Mr Smith" — and
 * the caller gets warnings back. The text is kept (a commander's note is a
 * record), but products leave free text out unless asked to include it.
 */
const CHECKS: { kind: FreeTextWarning['kind']; pattern: RegExp; message: string }[] = [
  // Bounded quantifiers keep every check linear in the length of the text.
  { kind: 'email', pattern: /[^\s@<>]{1,64}@[^\s@<>.]{1,63}(?:\.[^\s@<>.]{1,63}){0,8}\.[a-z]{2,24}\b/i, message: 'looks like an email address' },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/, message: 'looks like a Social Security number' },
  { kind: 'phone', pattern: /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, message: 'looks like a phone number' },
  { kind: 'plate', pattern: /\b(?:plates?|tags?|licen[cs]e)\b\W{0,3}(?:no\.?|number|#)?\W{0,3}[A-Z0-9]{2,4}[- ]?[A-Z0-9]{2,4}\b|\b[A-Z]{3}[- ]?\d{4}\b/i, message: 'may contain a licence plate' },
  { kind: 'dob', pattern: /\b(?:dob|d\.o\.b\.|date of birth|born on)\b/i, message: 'mentions a date of birth' },
  { kind: 'case_number', pattern: /\b(?:case|report|incident|arrest)\s*(?:no\.?|number|#)\s*[A-Z0-9][A-Z0-9-]{3,}/i, message: 'looks like a case or report number' },
  { kind: 'personal_title', pattern: /\b(?:Mr|Mrs|Ms|Miss|Mx)\.?\s+[A-Z][a-z]+/, message: 'may name a person' },
];

export function freeTextWarnings(text: string, field: string): FreeTextWarning[] {
  const warnings: FreeTextWarning[] = [];
  for (const check of CHECKS) {
    if (check.kind === 'email' && !text.includes('@')) continue;
    if (check.pattern.test(text)) warnings.push({ field, kind: check.kind, message: `${field} ${check.message}. Gameday Command must not hold personal data about the public.` });
  }
  return warnings;
}

/** Warnings for the named free-text fields of an object (dotted paths, arrays walked). */
export function warnFields(value: unknown, fields: string[]): FreeTextWarning[] {
  const out: FreeTextWarning[] = [];
  for (const field of fields) {
    for (const text of stringsAt(value, field.split('.'))) out.push(...freeTextWarnings(text, field));
  }
  return out;
}

function stringsAt(value: unknown, path: string[]): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => stringsAt(item, path));
  if (path.length === 0) return typeof value === 'string' ? [value] : [];
  if (typeof value !== 'object') return [];
  return stringsAt((value as Record<string, unknown>)[path[0]!], path.slice(1));
}
