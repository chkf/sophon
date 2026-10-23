import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialEncryptionAdapter } from "./sdk.js";

interface EncryptedEnvelope {
  version: 3;
  provider: string;
  ciphertext: string;
}

interface StoredProfile {
  id: string;
  status: string;
  scopes: string[];
  credentials?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

interface StoredState {
  version: 2;
  activeProfileId?: string;
  profiles: StoredProfile[];
}

const SHARING_SCOPE = "chatgpt.tokens.use.direct";

function parseEnvelope(value: unknown): EncryptedEnvelope {
  if (!value || typeof value !== "object") throw new Error("Invalid SIWC credential envelope.");
  const item = value as Partial<EncryptedEnvelope>;
  if (item.version !== 3 || typeof item.provider !== "string" || typeof item.ciphertext !== "string") {
    throw new Error("Unsupported SIWC credential envelope.");
  }
  return item as EncryptedEnvelope;
}

function parseState(value: unknown): StoredState {
  if (!value || typeof value !== "object") throw new Error("Invalid SIWC credential state.");
  const state = value as Partial<StoredState>;
  if (state.version !== 2 || !Array.isArray(state.profiles)) {
    throw new Error("Unsupported SIWC credential state.");
  }
  return state as StoredState;
}

export async function readActiveAccessToken(
  storageDir: string,
  encryption: CredentialEncryptionAdapter,
): Promise<string> {
  const envelope = parseEnvelope(JSON.parse(await readFile(join(storageDir, "chatgpt-auth.json"), "utf8")));
  if (envelope.provider !== encryption.id) {
    throw new Error("SIWC credential provider mismatch.");
  }

  const plaintext = await encryption.decrypt(Buffer.from(envelope.ciphertext, "base64"));
  const state = parseState(JSON.parse(plaintext));
  const profile = state.profiles.find((item) => item.id === state.activeProfileId);

  if (!profile || profile.status !== "connected" || !profile.scopes.includes(SHARING_SCOPE)) {
    throw new Error("The selected ChatGPT profile is not connected for plan usage.");
  }
  const token = profile.credentials?.accessToken;
  if (!token) throw new Error("The selected ChatGPT profile has no usable access token.");
  if (typeof profile.credentials?.expiresAt === "number" && profile.credentials.expiresAt <= Date.now()) {
    throw new Error("The selected ChatGPT access token is expired after refresh.");
  }
  return token;
}
