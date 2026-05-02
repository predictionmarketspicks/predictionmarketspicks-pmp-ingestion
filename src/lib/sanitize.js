// Discord-safe string sanitizer. Ported from supabase/functions/_shared/.
// Strips @everyone/@here pings (zero-width inside @ to keep the visible text),
// strips ASCII control chars except whitespace, then truncates to maxLen.

export function sanitize(text, maxLen = 1000) {
  if (text == null) return '';
  return String(text)
    .replace(/@everyone/gi, '@​everyone')
    .replace(/@here/gi, '@​here')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .slice(0, maxLen);
}
