// "alice@example.com" → "a***@example.com"
// "x@y.co"            → "x***@y.co"
// invalid input       → "" (caller decides whether to render anything)
export function maskEmail(email: string | null | undefined): string {
  if (!email || typeof email !== 'string') return '';
  const at = email.indexOf('@');
  if (at <= 0) return email; // no @ or @ at start — return unchanged
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.charAt(0);
  return `${head}***${domain}`;
}
