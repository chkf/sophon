import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatMessage, RuntimeSession } from "../types.js";

export interface CredentialEncryptionAdapter {
  id: string;
  isAvailable(): boolean | Promise<boolean>;
  encrypt(plaintext: string): Uint8Array | Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): string | Promise<string>;
}

export interface SiwcModel {
  slug: string;
  displayName: string;
}

export interface SiwcClient {
  signIn(options?: { newProfile?: boolean; profileId?: string; reconsent?: boolean }): Promise<RuntimeSession>;
  getSession(): Promise<RuntimeSession>;
  listModels(options?: { signal?: AbortSignal }): Promise<SiwcModel[]>;
  streamResponse(options: {
    model: string;
    input: string | ChatMessage[];
    instructions?: string;
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;
  }): Promise<{ text: string }>;
}

interface SiwcModule {
  createChatGPT(config: {
    appName: string;
    appId: string;
    redirectPort: number;
    storageDir: string;
    credentialEncryption: CredentialEncryptionAdapter;
    sendHostId: boolean;
    openBrowser?: (url: string) => Promise<void>;
  }): SiwcClient;
}

export async function loadSiwcModule(devkitDir: string): Promise<SiwcModule> {
  const entry = resolve(devkitDir, "packages/local/dist/index.js");
  try {
    await access(entry);
  } catch {
    throw new Error("Sign in with ChatGPT DevKit is not built at " + entry + '. Run "npm run bootstrap:siwc" first.');
  }

  const loaded = (await import(pathToFileURL(entry).href)) as Partial<SiwcModule>;
  if (typeof loaded.createChatGPT !== "function") {
    throw new Error("The local Sign in with ChatGPT DevKit build does not export createChatGPT().");
  }
  return loaded as SiwcModule;
}
