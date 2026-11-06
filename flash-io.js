import MD5 from 'crypto-js/md5.js';
import Latin1 from 'crypto-js/enc-latin1.js';
import { FACTORY_START, FACTORY_SIZE, binaryString } from './safety.js';

// esptool-js 0.5.4 readFlash returns the data but leaves the stub's final
// 16-byte MD5 packet in the serial stream. Consume and verify it before
// issuing another command; otherwise it can corrupt the next response.
export async function readFactory(loader, transport, progress = null) {
  const data = await loader.readFlash(FACTORY_START, FACTORY_SIZE, progress);
  if (data.length !== FACTORY_SIZE) throw new Error('Incomplete factory partition read');
  const { value: digest } = await transport.read(loader.FLASH_READ_TIMEOUT).next();
  if (!(digest instanceof Uint8Array) || digest.length !== 16) throw new Error('Missing flash read MD5 packet');
  const actual = Array.from(digest, b => b.toString(16).padStart(2,'0')).join('');
  const expected = MD5(Latin1.parse(binaryString(data))).toString();
  if (actual !== expected) throw new Error('Factory backup read MD5 mismatch');
  return data;
}
