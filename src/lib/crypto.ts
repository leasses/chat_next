/**
 * Client-side encryption utilities using Web Crypto API
 * AES-256-GCM with PBKDF2 key derivation (per-user salt)
 */

const PBKDF2_ITERATIONS = 100000
const KEY_LENGTH = 256
const IV_LENGTH = 12 // 96 bits for GCM
const SALT_LENGTH = 32 // 256 bits
const TAG_LENGTH = 128 // 128 bits for GCM

/**
 * Convert ArrayBuffer to base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Convert base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

/**
 * Generate a random salt (hex encoded for PocketBase storage)
 */
export function generateSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  return Array.from(salt, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Derive encryption key from password and salt using PBKDF2
 */
export async function deriveKey(password: string, saltHex: string): Promise<CryptoKey> {
  const pairs = saltHex.match(/.{1,2}/g) ?? []
  if (pairs.length !== 32) {
    throw new Error('Invalid salt')
  }
  const salt = new Uint8Array(pairs.map((byte) => parseInt(byte, 16))).buffer
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false, // not extractable
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypt data with AES-256-GCM
 * Returns base64 encoded: iv + ciphertext + authTag
 */
export async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(plaintext)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH },
    key,
    data
  )

  // Combine iv + ciphertext (which includes auth tag at the end for AES-GCM)
  const result = new Uint8Array(IV_LENGTH + encrypted.byteLength)
  result.set(iv)
  result.set(new Uint8Array(encrypted), IV_LENGTH)

  return arrayBufferToBase64(result.buffer)
}

/**
 * Decrypt data with AES-256-GCM
 * Expects base64 encoded: iv + ciphertext + authTag
 */
export async function decrypt(ciphertextBase64: string, key: CryptoKey): Promise<string> {
  const data = base64ToArrayBuffer(ciphertextBase64)
  const iv = data.slice(0, IV_LENGTH)
  const ciphertext = data.slice(IV_LENGTH)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: TAG_LENGTH },
    key,
    ciphertext
  )

  const decoder = new TextDecoder()
  return decoder.decode(decrypted)
}

/**
 * Encrypt JSON object
 */
export async function encryptJSON<T>(obj: T, key: CryptoKey): Promise<string> {
  return encrypt(JSON.stringify(obj), key)
}

/**
 * Decrypt JSON object
 */
export async function decryptJSON<T>(ciphertextBase64: string, key: CryptoKey): Promise<T> {
  const plaintext = await decrypt(ciphertextBase64, key)
  return JSON.parse(plaintext)
}