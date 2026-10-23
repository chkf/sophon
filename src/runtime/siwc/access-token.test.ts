import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActiveAccessToken } from "./access-token.js";
import type { CredentialEncryptionAdapter } from "./sdk.js";

const encryption: CredentialEncryptionAdapter = {
  id: "test-provider",
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, "utf8"),
  decrypt: (ciphertext) => Buffer.from(ciphertext).toString("utf8"),
};

test("reads only the active connected SIWC plan token from encrypted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-access-token-"));
  try {
    await mkdir(directory, { recursive: true });
    const state = {
      version: 2,
      activeProfileId: "p1",
      profiles: [{
        id: "p1",
        status: "connected",
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        credentials: { accessToken: "secret-access-token", expiresAt: Date.now() + 60_000 },
      }],
    };
    const envelope = {
      version: 3,
      provider: encryption.id,
      ciphertext: Buffer.from(JSON.stringify(state)).toString("base64"),
    };
    await writeFile(join(directory, "chatgpt-auth.json"), JSON.stringify(envelope), { mode: 0o600 });
    assert.equal(await readActiveAccessToken(directory, encryption), "secret-access-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
