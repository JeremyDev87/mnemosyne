import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export interface DeviceRequest { deviceId: string; timestamp: number; nonce: string; method: string; path: string; bodySha256: string; signature?: string }
export interface DeviceKeyPair { publicKey: KeyObject; privateKey: KeyObject }
export interface DeviceKeyRegistry { getPublicKey(deviceId: string): KeyObject | undefined }
export interface NonceStore { claim(nonce: string, expiresAt: number, now: number): boolean }

export class InMemoryDeviceKeyRegistry implements DeviceKeyRegistry {
  private readonly keys = new Map<string, KeyObject>();
  register(deviceId: string, publicKey: KeyObject): void { if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) throw new Error("invalid device id"); this.keys.set(deviceId, publicKey); }
  revoke(deviceId: string): void { this.keys.delete(deviceId); }
  getPublicKey(deviceId: string): KeyObject | undefined { return this.keys.get(deviceId); }
}

export class InMemoryNonceStore implements NonceStore {
  private readonly nonces = new Map<string, number>();
  claim(nonce: string, expiresAt: number, now: number): boolean {
    for (const [key, expiry] of this.nonces) if (expiry <= now) this.nonces.delete(key);
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAt);
    return true;
  }
}

export function createDeviceKeyPair(): DeviceKeyPair { return generateKeyPairSync("ed25519"); }

function canonicalRequest(request: Omit<DeviceRequest, "signature">): Buffer {
  return Buffer.from([request.deviceId, String(request.timestamp), request.nonce, request.method.toUpperCase(), request.path, request.bodySha256].join("\n"), "utf8");
}

export function signDeviceRequest(request: Omit<DeviceRequest, "signature">, privateKey: KeyObject): DeviceRequest {
  const unsigned = { ...request, method: request.method.toUpperCase() };
  return { ...unsigned, signature: sign(null, canonicalRequest(unsigned), privateKey).toString("base64url") };
}

export function bodyDigest(body: string | Buffer): string { return createHash("sha256").update(body).digest("hex"); }

export function verifyDeviceRequest(request: DeviceRequest, body: string | Buffer, keyRegistry: DeviceKeyRegistry, nonceStore: NonceStore, now = Date.now(), skewMs = 5 * 60 * 1000): void {
  if (!request.signature || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.deviceId) || !/^[A-Za-z0-9._:-]{16,256}$/.test(request.nonce) || !Number.isFinite(request.timestamp)) throw new Error("invalid device request");
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(request.path) || !request.method) throw new Error("invalid device request target");
  if (Math.abs(now - request.timestamp) >= skewMs) throw new Error("device request timestamp outside replay window");
  if (!/^[a-f0-9]{64}$/.test(request.bodySha256) || bodyDigest(body) !== request.bodySha256) throw new Error("device request body digest mismatch");
  const publicKey = keyRegistry.getPublicKey(request.deviceId);
  if (!publicKey) throw new Error("unknown device id");
  const unsigned = { deviceId: request.deviceId, timestamp: request.timestamp, nonce: request.nonce, method: request.method.toUpperCase(), path: request.path, bodySha256: request.bodySha256 };
  if (!verify(null, canonicalRequest(unsigned), publicKey, Buffer.from(request.signature, "base64url"))) throw new Error("invalid device request signature");
  if (!nonceStore.claim(request.nonce, request.timestamp + skewMs, now)) throw new Error("device request nonce replay");
}
