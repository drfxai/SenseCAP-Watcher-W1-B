import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedPreviousStage} from '../recovery-report.js';
const valid={device:{eui:'test-eui'},stages:{esp32:{version:'1.1.7',verified:true,factoryPartitionPreserved:true}}};
test('imports older successful reports without requiring the new schema',()=>{
  assert.equal(verifiedPreviousStage(valid,'test-eui').importedFromReport,true);
});
test('rejects failed reports or reports for another device',()=>{
  assert.throws(()=>verifiedPreviousStage(valid,'other-eui'));
  assert.throws(()=>verifiedPreviousStage({...valid,stages:{esp32:{verified:false}}},'test-eui'));
  assert.throws(()=>verifiedPreviousStage(null,'test-eui'));
});
