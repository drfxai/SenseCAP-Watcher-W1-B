import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateParts, binaryString, sha256 } from '../safety.js';
const manifest = JSON.parse(readFileSync(new URL('../public/firmware/manifest.json', import.meta.url)));
test('official package and optional NVS reset avoid factory sectors', () => {
  validateParts([...manifest.parts, {offset:0x3b000,size:0xd2000}]);
});
test('rejects writes whose erased sectors touch factory data', () => {
  assert.throws(() => validateParts([{offset:0x8fff,size:2}]), /factory/);
  assert.throws(() => validateParts([{offset:0x9000,size:1}]), /factory/);
  assert.throws(() => validateParts([{offset:0x3afff,size:1}]), /factory/);
  assert.throws(() => validateParts([{offset:0,size:0x2000000}]), /factory/);
});
test('rejects overlapping, out-of-bounds and invalid ranges', () => {
  for (const parts of [[{offset:0,size:100},{offset:100,size:10}], [{offset:-1,size:4}], [{offset:0x1ffffff,size:2}], [{offset:0,size:0}], [{offset:0.5,size:1}]]) assert.throws(() => validateParts(parts));
});
test('binary conversion preserves all byte values across chunk boundaries', () => {
  const bytes = Uint8Array.from({length:25000}, (_,i) => i%256);
  assert.deepEqual(Uint8Array.from(binaryString(bytes), c => c.charCodeAt(0)), bytes);
});
test('every local image matches its SHA-256 and length', async () => {
  for (const part of [...manifest.parts,manifest.himax]) {
    const bytes=readFileSync(new URL('../public/'+part.path, import.meta.url));
    assert.equal(bytes.length, part.size);
    assert.equal(await sha256(bytes), part.sha256);
  }
});
