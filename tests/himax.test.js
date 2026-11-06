import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, makePacket, HimaxFlasher, HIMAX_SIZE, SerialChannel } from '../himax.js';
const enc=new TextEncoder();
const menu='Himax Bootloader\r\n1. Xmodem download and burn FW image\r\n';
const prompt='Send data using the xmodem protocol from your terminal\r\nC';
class VirtualHimax {
  constructor({retry=false,can=false,completion=true}={}) {this.queue=[];this.packets=[];this.retry=retry;this.can=can;this.completion=completion;this.eot=0;this.rebooted=false;this.time=0;}
  enqueue(text) {this.queue.push(...enc.encode(text));}
  async readByte(timeout) {if(this.queue.length)return this.queue.shift();this.time+=timeout;return null;}
  async write(bytes) {
    const text=new TextDecoder().decode(bytes);
    if(text.includes('AT+RST')){this.enqueue(menu);return;}
    if(text==='1'){this.enqueue(prompt);return;}
    if(text==='y'){this.rebooted=true;return;}
    if(bytes[0]===1 && bytes.length===133) {
      assert.equal(bytes[1]+bytes[2],255);
      const crc=crc16(bytes.subarray(3,131));assert.equal(crc,(bytes[131]<<8)|bytes[132]);
      if(this.can){this.queue.push(0x18);return;}
      if(this.retry){this.retry=false;this.queue.push(0x15);return;}
      assert.equal(bytes[1],(this.packets.length+1)&255);
      this.packets.push(bytes.slice(3,131));this.queue.push(6);return;
    }
    if(bytes.length===1 && bytes[0]===4){
      this.eot++;
      if(this.eot===1){this.queue.push(0x15);return;}
      this.queue.push(6);
      if(this.completion)this.enqueue('Do you want to end file transmission and reboot system?');
      return;
    }
    throw new Error('Unexpected host packet');
  }
}
test('CRC matches standard XMODEM test vector; last packet is padded correctly',()=>{
  assert.equal(crc16(enc.encode('123456789')),0x31c3);
  const p=makePacket(256,new Uint8Array([7]));assert.equal(p[1],0);assert.equal(p[2],255);assert.equal(p[3],7);assert.equal(p[130],0x1a);
});
test('complete image: validates all packets, handles NAK retry, sequence rollover and double EOT',async()=>{
  const channel=new VirtualHimax({retry:true});
  let done=0;
  const flasher=new HimaxFlasher(channel,{now:()=>channel.time,progress:n=>{done=n;}});
  await flasher.connect();
  const bytes=Uint8Array.from({length:HIMAX_SIZE},(_,i)=>i%251);
  await flasher.flash(bytes);
  assert.equal(channel.packets.length,Math.ceil(HIMAX_SIZE/128));assert.equal(done,HIMAX_SIZE);assert.equal(channel.eot,2);assert.equal(channel.rebooted,true);
  assert.deepEqual(Buffer.concat(channel.packets).subarray(0,HIMAX_SIZE),Buffer.from(bytes));
});
test('a random C or wrong UART never authorizes firmware transfer',async()=>{
  let time=0;const writes=[];
  const flasher=new HimaxFlasher({readByte:async n=>{time+=n;return 0x43;},write:async bytes=>writes.push(bytes)},{now:()=>time});
  await assert.rejects(flasher.connect({timeout:500}),/No verified Himax/);
  await assert.rejects(flasher.flash(new Uint8Array(HIMAX_SIZE)),/Verified Himax/);
  assert(writes.every(b=>b.length<133));
});
test('menu without transfer prompt is insufficient',async()=>{
  let time=0;const queue=[...enc.encode(menu+'CCCCCC')];
  const flasher=new HimaxFlasher({readByte:async n=>{time+=n;return queue.shift()??null;},write:async()=>{}},{now:()=>time});
  await assert.rejects(flasher.connect({timeout:10000}),/No verified Himax/);assert.equal(flasher.ready,false);
});
test('receiver cancellation and missing completion are failures, not success',async()=>{
  const cancelled=new VirtualHimax({can:true});const first=new HimaxFlasher(cancelled,{now:()=>cancelled.time});await first.connect();
  await assert.rejects(first.flash(new Uint8Array(HIMAX_SIZE)),/cancelled/);
  const missing=new VirtualHimax({completion:false});const second=new HimaxFlasher(missing,{now:()=>missing.time});await second.connect();
  await assert.rejects(second.flash(new Uint8Array(HIMAX_SIZE)),/completion prompt/);assert.equal(missing.rebooted,false);
});
test('abort stops before a packet can be written',async()=>{
  const channel=new VirtualHimax();const controller=new AbortController();const flasher=new HimaxFlasher(channel,{signal:controller.signal,now:()=>channel.time});
  await flasher.connect();controller.abort();await assert.rejects(flasher.flash(new Uint8Array(HIMAX_SIZE)),/cancelled/);assert.equal(channel.packets.length,0);
});
test('timed serial read does not steal the next packet; close releases locks',async()=>{
  let controller,closed=false;
  const readable=new ReadableStream({start(c){controller=c;}});
  const writable=new WritableStream({write(){}});
  const channel=new SerialChannel({open:async()=>{},readable,writable,close:async()=>{closed=true;}});
  await channel.open();assert.equal(await channel.readByte(5),null);
  controller.enqueue(new Uint8Array([6,21]));assert.equal(await channel.readByte(100),6);assert.equal(await channel.readByte(100),21);
  await channel.close();assert.equal(readable.locked,false);assert.equal(writable.locked,false);assert.equal(closed,true);
});
