import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialEncryption } from "./credential-encryption.js";
import { decryptAesGcm, encryptAesGcm } from "./crypto.js";

test("AES-GCM credential envelope round-trips unicode text", () => {
  const key = randomBytes(32);
  const plaintext = "Gateway token fixture · 测试";
  const encrypted = encryptAesGcm(key, plaintext);

  assert.notEqual(Buffer.from(encrypted).toString("utf8"), plaintext);
  assert.equal(decryptAesGcm(key, encrypted), plaintext);
});

test("AES-GCM credential envelope rejects tampering", () => {
  const key = randomBytes(32);
  const encrypted = Buffer.from(encryptAesGcm(key, "fixture"));
  encrypted[encrypted.length - 1] ^= 1;

  assert.throws(() => decryptAesGcm(key, encrypted));
});


test("managed key file encrypts credentials for headless deployment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sophon-key-"));
  const path = join(directory, "credential.key");
  try {
    await writeFile(path, randomBytes(32).toString("base64") + "\n");
    await chmod(path, 0o600);
    const provider = createCredentialEncryption("linux", path);
    assert.equal(await provider.isAvailable(), true);
    const ciphertext = await provider.encrypt("oauth-fixture");
    assert.equal(await provider.decrypt(ciphertext), "oauth-fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
