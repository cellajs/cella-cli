import { createPrivateKey, createPublicKey, hkdfSync } from 'node:crypto';

/**
 * The Yjs relay's public key for the backend's token key material: the Ed25519 seed is HKDF-SHA256 of the material.
 * @returns base64url of the raw 32-byte key
 */
export function yjsTokenPublicKey(material: string): string {
  const seed = Buffer.from(hkdfSync('sha256', material, '', 'yjs-token-ed25519', 32));
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const { x } = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  if (!x) throw new Error('yjs-token: Ed25519 public key export carried no key bytes');
  return x;
}
