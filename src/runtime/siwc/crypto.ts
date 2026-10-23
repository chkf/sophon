import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function assertAes256Key(key: Uint8Array): Buffer {
  const buffer = Buffer.from(key);
  if (buffer.length !== KEY_BYTES) {
    throw new Error(`Expected a ${KEY_BYTES}-byte encryption key.`);
  }
  return buffer;
}

export function encryptAesGcm(key: Uint8Array, plaintext: string): Uint8Array {
  const normalizedKey = assertAes256Key(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", normalizedKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
}

export function decryptAesGcm(key: Uint8Array, payload: Uint8Array): string {
  const normalizedKey = assertAes256Key(key);
  const bytes = Buffer.from(payload);
  const minimum = 1 + IV_BYTES + TAG_BYTES;
  if (bytes.length < minimum || bytes[0] !== VERSION) {
    throw new Error("Unsupported or damaged credential ciphertext.");
  }

  const ivStart = 1;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const iv = bytes.subarray(ivStart, tagStart);
  const tag = bytes.subarray(tagStart, ciphertextStart);
  const ciphertext = bytes.subarray(ciphertextStart);

  const decipher = createDecipheriv("aes-256-gcm", normalizedKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
