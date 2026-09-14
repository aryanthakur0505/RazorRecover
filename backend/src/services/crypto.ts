import crypto from "crypto";
import { env } from "../env";

/**
 * Password hashing (scrypt) and at-rest secret encryption (AES-256-GCM) for merchant accounts —
 * see the Merchant model doc in schema.prisma for what each field is used for. Deliberately built
 * on Node's own `crypto` module rather than adding bcrypt/argon2 as a dependency: scrypt is an
 * OWASP-acceptable KDF, needs no native addon, and is already exactly what this app's session
 * cookie signing (middleware/session.ts) trusts the platform for.
 */

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** Constant-time compare — never short-circuits on the first differing byte, so a wrong-password
 *  response can't be distinguished from a right one by timing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// --- At-rest encryption for stored Razorpay credentials -----------------------------------

// Derived from SESSION_SECRET rather than a separate required env var — one less secret to
// configure, and SESSION_SECRET is already required to be a long random string nothing else ever
// reads back out (it only ever flows into an HMAC, one-way). `scryptSync` with a fixed,
// app-specific salt turns it into a proper 32-byte AES key instead of using arbitrary,
// possibly-short operator input directly as key material.
const ENCRYPTION_KEY = crypto.scryptSync(env.SESSION_SECRET, "razorrecover:credential-encryption", 32);
const IV_BYTES = 12; // recommended IV length for AES-GCM

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

export function decryptSecret(stored: string): string {
  const [ivHex, tagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !tagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted secret.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}
