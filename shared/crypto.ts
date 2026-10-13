// Web port of src-tauri/src/crypto.rs: same JSON envelopes, same AAD strings, so a vault made on
// the desktop opens here and the other way round. AES-256-GCM via Web Crypto, Argon2id via hash-wasm.

import { argon2id } from "hash-wasm";

export interface Envelope {
  v: number;
  kdf?: { alg: string; m: number; t: number; p: number; salt: string };
  n: string;
  c: string;
}

const AAD_WRAP_PASS = "stickit/v1/wrap/passphrase";
const te = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;
const fromB64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

const aesKey = (raw: Bytes, use: KeyUsage[]) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, use);

async function open(key: CryptoKey, aad: string, e: Envelope): Promise<Uint8Array> {
  if (e.v !== 1) throw new Error(`unsupported format version ${e.v}`);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(e.n), additionalData: te.encode(aad) },
      key,
      fromB64(e.c),
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error("wrong passphrase or corrupted data");
  }
}

async function seal(key: CryptoKey, aad: string, plain: Bytes): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, plain);
  return { v: 1, n: toB64(iv), c: toB64(new Uint8Array(ct)) };
}

async function derive(pass: string, kdf: NonNullable<Envelope["kdf"]>): Promise<CryptoKey> {
  // These come from public data, so bound them before allocating memory for them.
  if (kdf.alg !== "argon2id" || kdf.m > 512 * 1024 || kdf.t > 10 || kdf.p > 4) {
    throw new Error("unsupported key derivation parameters");
  }
  const raw = await argon2id({
    password: pass,
    salt: fromB64(kdf.salt),
    memorySize: kdf.m,
    iterations: kdf.t,
    parallelism: kdf.p,
    hashLength: 32,
    outputType: "binary",
  });
  return aesKey(raw as Bytes, ["decrypt"]);
}

export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Vault {
  private constructor(private key: CryptoKey) {}

  static async unlock(wrap: Envelope, pass: string): Promise<Vault> {
    if (!wrap.kdf) throw new Error("missing key derivation parameters");
    const raw = await open(await derive(pass, wrap.kdf), AAD_WRAP_PASS, wrap);
    if (raw.length !== 32) throw new Error("bad key length");
    return new Vault(await aesKey(raw as Bytes, ["encrypt", "decrypt"]));
  }

  sealNote(uid: string, plain: string) {
    return this.sealCtx(`note/${uid}`, plain);
  }
  openNote(uid: string, sealed: string) {
    return this.openCtx(`note/${uid}`, sealed);
  }
  sealSecret(name: string, plain: string) {
    return this.sealCtx(`secret/${name}`, plain);
  }
  openSecret(name: string, sealed: string) {
    return this.openCtx(`secret/${name}`, sealed);
  }

  private async sealCtx(ctx: string, plain: string) {
    return JSON.stringify(await seal(this.key, `stickit/v1/${ctx}`, te.encode(plain)));
  }

  private async openCtx(ctx: string, sealed: string) {
    let e: Envelope;
    try {
      e = JSON.parse(sealed);
    } catch {
      throw new Error("not a sealed note");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(await open(this.key, `stickit/v1/${ctx}`, e));
  }
}
