import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const VERSION = 'v1';

function parseEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');

  if (key.length !== 32) {
    throw new Error('Token encryption key must be 32 bytes.');
  }

  return key;
}

export function encryptGitHubToken(token: string, encodedKey: string): string {
  const key = parseEncryptionKey(encodedKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptGitHubToken(encryptedToken: string, encodedKey: string): string {
  const [version, ivValue, authTagValue, ciphertextValue] = encryptedToken.split('.');

  if (version !== VERSION || !ivValue || !authTagValue || !ciphertextValue) {
    throw new Error('Stored GitHub token is invalid.');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    parseEncryptionKey(encodedKey),
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
