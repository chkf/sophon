import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { decryptAesGcm, encryptAesGcm } from "./crypto.js";
import type { CredentialEncryptionAdapter } from "./sdk.js";

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function runCommand(command: string, args: string[], input = ""): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(command + " timed out."));
    }, 15_000);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (code === 0) resolve(result);
      else reject(new Error(result.stderr || command + " exited with code " + (code ?? "unknown") + "."));
    });
    child.stdin.end(input);
  });
}

async function readManagedKey(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Managed credential key file must not be group/world accessible.");
  }
  const raw = (await readFile(path, "utf8")).trim();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) {
    throw new Error("Managed credential key file must contain exactly 32 bytes encoded as base64.");
  }
  return key;
}

function createManagedKeyProvider(path: string): CredentialEncryptionAdapter {
  // Persisted adapter IDs and keyring attributes stay stable across project renames.
  return {
    id: "gateway-framework-managed-key-aesgcm-v1",
    async isAvailable() {
      try {
        await readManagedKey(path);
        return true;
      } catch {
        return false;
      }
    },
    async encrypt(plaintext) {
      return encryptAesGcm(await readManagedKey(path), plaintext);
    },
    async decrypt(ciphertext) {
      return decryptAesGcm(await readManagedKey(path), ciphertext);
    },
  };
}

function createWindowsDpapiProvider(): CredentialEncryptionAdapter {
  const protectScript = [
    "Add-Type -AssemblyName System.Security",
    "$inputB64 = [Console]::In.ReadToEnd().Trim()",
    "$plain = [Convert]::FromBase64String($inputB64)",
    "$protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))",
  ].join("\n");
  const unprotectScript = [
    "Add-Type -AssemblyName System.Security",
    "$inputB64 = [Console]::In.ReadToEnd().Trim()",
    "$protected = [Convert]::FromBase64String($inputB64)",
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))",
  ].join("\n");
  const probeScript = [
    "Add-Type -AssemblyName System.Security",
    "[Console]::Out.Write([System.Security.Cryptography.DataProtectionScope]::CurrentUser.ToString())",
  ].join("\n");

  return {
    id: "gateway-framework-windows-dpapi-v1",
    async isAvailable() {
      try {
        await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probeScript]);
        return true;
      } catch {
        return false;
      }
    },
    async encrypt(plaintext) {
      const input = Buffer.from(plaintext, "utf8").toString("base64");
      const { stdout } = await runCommand(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", protectScript],
        input,
      );
      return Buffer.from(stdout, "base64");
    },
    async decrypt(ciphertext) {
      const { stdout } = await runCommand(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", unprotectScript],
        Buffer.from(ciphertext).toString("base64"),
      );
      return Buffer.from(stdout, "base64").toString("utf8");
    },
  };
}

const LINUX_SECRET_ATTRIBUTES = ["service", "gateway-framework", "account", "oauth-encryption-key"];

async function lookupLinuxKey(): Promise<Buffer | undefined> {
  try {
    const { stdout } = await runCommand("secret-tool", ["lookup", ...LINUX_SECRET_ATTRIBUTES]);
    if (!stdout) return undefined;
    const key = Buffer.from(stdout, "base64");
    return key.length === 32 ? key : undefined;
  } catch {
    return undefined;
  }
}

async function createLinuxKey(): Promise<Buffer> {
  const key = randomBytes(32);
  await runCommand(
    "secret-tool",
    ["store", "--label=Sophon OAuth encryption key", ...LINUX_SECRET_ATTRIBUTES],
    key.toString("base64") + "\n",
  );
  return key;
}

function createLinuxSecretServiceProvider(): CredentialEncryptionAdapter {
  return {
    id: "gateway-framework-linux-libsecret-aesgcm-v1",
    async isAvailable() {
      try {
        await runCommand("secret-tool", ["--help"]);
        return true;
      } catch {
        return false;
      }
    },
    async encrypt(plaintext) {
      const key = (await lookupLinuxKey()) ?? (await createLinuxKey());
      return encryptAesGcm(key, plaintext);
    },
    async decrypt(ciphertext) {
      const key = await lookupLinuxKey();
      if (!key) throw new Error("Gateway credential key is missing from the Linux Secret Service.");
      return decryptAesGcm(key, ciphertext);
    },
  };
}

export function createCredentialEncryption(
  platform: NodeJS.Platform = process.platform,
  managedKeyFile?: string,
): CredentialEncryptionAdapter {
  if (managedKeyFile) return createManagedKeyProvider(managedKeyFile);
  if (platform === "win32") return createWindowsDpapiProvider();
  if (platform === "linux") return createLinuxSecretServiceProvider();
  throw new Error(
    "No credential encryption adapter is configured for " + platform +
    ". Use Windows DPAPI, Linux Secret Service, or GATEWAY_CREDENTIAL_KEY_FILE.",
  );
}
