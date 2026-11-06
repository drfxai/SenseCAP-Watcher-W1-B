import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFactory } from '../flash-io.js';
const data = new Uint8Array(0x32000).fill(0xa5);
const digest = new Uint8Array(createHash('md5').update(data).digest());
const loader = {readFlash:async()=>data};
test('consumes and verifies final stub MD5 packet after reading backup', async () => {
  let reads=0;
  const transport={async *read(){reads++;yield digest;}};
  assert.equal(await readFactory(loader,transport),data);
  assert.equal(reads,1);
});
test('rejects incomplete or damaged factory reads',async()=>{
  await assert.rejects(readFactory({readFlash:async()=>new Uint8Array(1)},{}),/Incomplete/);
  await assert.rejects(readFactory(loader,{async *read(){yield new Uint8Array(16);}}),/MD5 mismatch/);
  await assert.rejects(readFactory(loader,{async *read(){yield new Uint8Array(4);}}),/Missing/);
});
