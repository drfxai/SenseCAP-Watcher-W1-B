export const FACTORY_START = 0x9000;
export const FACTORY_SIZE = 0x32000;
export const FLASH_SIZE = 32 * 1024 * 1024;
export function validateParts(parts) {
  const ranges = [];
  for (const part of parts) {
    const { offset, size } = part;
    if (!Number.isInteger(offset) || !Number.isInteger(size) || size <= 0 || offset < 0 || offset + size > FLASH_SIZE) throw new Error('Invalid flash range');
    const start = Math.floor(offset / 4096) * 4096;
    const end = Math.ceil((offset + size) / 4096) * 4096;
    if (start < FACTORY_START + FACTORY_SIZE && end > FACTORY_START) throw new Error('Write would erase factory credentials');
    if (ranges.some(([a, b]) => start < b && end > a)) throw new Error('Overlapping flash sectors');
    ranges.push([start, end]);
  }
}
export function binaryString(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return result;
}
export async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
