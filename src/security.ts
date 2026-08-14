const encoder = new TextEncoder();

export function maskSecret(secret: string): string {
  const separator = secret.indexOf('-');
  const prefix = separator >= 0 ? secret.slice(0, separator + 1) : '';
  const suffixLength = Math.min(4, secret.length);
  const suffix = secret.slice(-suffixLength);
  const maskLength = Math.max(8, secret.length - prefix.length - suffixLength);
  return `${prefix}${'*'.repeat(maskLength)}${suffix}`;
}

export async function secretFingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}
