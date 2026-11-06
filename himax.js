// Himax WE2 UART bootloader / XMODEM-CRC (128-byte packets).
// Protocol references: Seeed python-sscma c48838f and Watcher SDK flasher_we2_uart.
export const HIMAX_BAUD = 921600;
export const HIMAX_SIZE = 548864;
export const HIMAX_SHA256 = '55ab2bcaee3bf6e0fad149bb06b36139610bb5578847b94c59937eb32875d0fd';
const encoder = new TextEncoder();
export function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit=0; bit<8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
export function makePacket(sequence, bytes) {
  if (bytes.length > 128 || bytes.length === 0) throw new Error('Invalid XMODEM payload');
  const packet = new Uint8Array(133);
  packet[0]=1; packet[1]=sequence & 255; packet[2]=255-packet[1];
  packet.fill(0x1a, 3, 131); packet.set(bytes,3);
  const crc=crc16(packet.subarray(3,131)); packet[131]=crc >>> 8; packet[132]=crc & 255;
  return packet;
}

// One permanent stream reader: timed reads never leave pending reader.read()
// calls that could consume ACKs belonging to subsequent packets.
export class SerialChannel {
  constructor(port) { this.port=port; this.queue=[]; this.waiter=null; this.closed=false; this.failure=null; }
  async open() {
    await this.port.open({baudRate:HIMAX_BAUD, dataBits:8, stopBits:1, parity:'none', flowControl:'none',bufferSize:65536});
    this.reader=this.port.readable.getReader(); this.writer=this.port.writable.getWriter();
    this.pump=this.readLoop();
  }
  async readLoop() {
    try {
      while (!this.closed) {
        const {value,done}=await this.reader.read();
        if (done) break;
        for (const byte of value) this.queue.push(byte);
        if (this.queue.length > 65536) throw new Error('Serial receive buffer overflow');
        this.waiter?.();
      }
      if (!this.closed) this.failure=new Error('Serial connection ended');
    } catch(error) { if (!this.closed) this.failure=error; }
    finally { this.waiter?.(); }
  }
  async readByte(timeout=1000) {
    const end=Date.now()+timeout;
    while (!this.queue.length) {
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error('Serial connection closed');
      const remaining=end-Date.now(); if (remaining<=0) return null;
      await new Promise(resolve=>{
        const wake=()=>{clearTimeout(timer); if(this.waiter===wake)this.waiter=null;resolve();};
        const timer=setTimeout(wake,remaining); this.waiter=wake;
      });
    }
    return this.queue.shift();
  }
  write(bytes) { if(this.closed) throw new Error('Serial connection closed');return this.writer.write(bytes); }
  async close() {
    if(this.closed)return; this.closed=true; this.waiter?.();
    try {await this.reader?.cancel();await this.pump;} catch { /* physical unplug */ }
    this.reader?.releaseLock();this.writer?.releaseLock();
    await this.port.close().catch(()=>{});
  }
}

export class HimaxFlasher {
  constructor(channel,{log=()=>{},progress=()=>{},signal,now=()=>Date.now()}={}) {
    this.channel=channel;this.log=log;this.progress=progress;this.signal=signal;this.now=now;
    this.recognized=false;this.ready=false;this.transferring=false;this.tail='';
  }
  checkAbort() { if(this.signal?.aborted) throw new Error('Himax operation cancelled'); }
  async byte(timeout=1000) {this.checkAbort();const byte=await this.channel.readByte(timeout);this.checkAbort();return byte;}
  async send(bytes) {this.checkAbort();await this.channel.write(bytes);}
  async text(value) {await this.send(encoder.encode(value));}
  observe(byte) {if(byte!==null)this.tail=(this.tail+String.fromCharCode(byte)).slice(-4096);}
  async connect({timeout=30000}={}) {
    // AT+RST is the official application reset command; on a blank chip the
    // user may need a physical reset. Never infer Himax from USB ID or a lone C.
    await this.text('\rAT+RST\r\n');
    let nextSelect=0,selected=false;
    const deadline=this.now()+timeout;
    this.log('Waiting for Himax bootloader. Reset device now if no response.');
    while(this.now()<deadline) {
      if(this.now()>=nextSelect && !selected) {await this.text('1');nextSelect=this.now()+150;}
      const byte=await this.byte(100);this.observe(byte);
      if(!this.recognized && this.tail.includes('Xmodem download and burn FW image')) {
        this.recognized=true;this.log('Himax bootloader menu recognized.');
        await this.text('1');selected=true;
      }
      const prompt=this.tail.includes('Send data using the xmodem protocol from your terminal');
      if(prompt && !this.recognized) {this.recognized=true;this.log('Himax bootloader transfer prompt recognized.');}
      if(this.recognized && prompt && byte===0x43) {
        this.ready=true;this.log('Himax XMODEM-CRC receiver ready.');return;
      }
    }
    throw new Error('No verified Himax bootloader response. Select its other UART port and reset the device; no firmware was sent.');
  }
  async response(timeout=10000) {
    const deadline=this.now()+timeout;
    while(this.now()<deadline) {
      const byte=await this.byte(Math.min(1000,Math.max(1,deadline-this.now())));
      if(byte===0x06 || byte===0x15)return byte;
      if(byte===0x18)throw new Error('Himax bootloader cancelled the transfer');
    }
    return null;
  }
  async flash(bytes) {
    if(!this.ready || !this.recognized)throw new Error('Verified Himax connection required');
    if(bytes.length!==HIMAX_SIZE)throw new Error('Unexpected Himax image size');
    this.transferring=true;
    for(let offset=0,index=1;offset<bytes.length;offset+=128,index++) {
      const packet=makePacket(index,bytes.subarray(offset,offset+128));
      let accepted=false;
      for(let retry=0;retry<15;retry++) {
        await this.send(packet);
        if(await this.response()===0x06) {accepted=true;break;}
        this.log(`Himax retry: packet ${index}, attempt ${retry+1}`);
      }
      if(!accepted)throw new Error(`Himax packet ${index} was not acknowledged`);
      this.progress(Math.min(offset+128,bytes.length),bytes.length);
    }
    let finished=false;
    for(let retry=0;retry<15;retry++) {
      await this.send(new Uint8Array([4])); // EOT; receivers may NAK the first EOT.
      if(await this.response()===6) {finished=true;break;}
    }
    if(!finished)throw new Error('Himax did not acknowledge end of image');
    this.tail='';
    const deadline=this.now()+60000;
    while(this.now()<deadline) {
      this.observe(await this.byte(1000));
      if(this.tail.includes('Do you want to end file transmission and reboot system')) {
        await this.text('y');this.transferring=false;this.ready=false;
        this.log('Himax acknowledged image transfer and requested reboot.');return;
      }
    }
    throw new Error('Image transferred but Himax burn-completion prompt was not confirmed');
  }
  async cancel() {
    if(this.recognized && this.transferring)await this.channel.write(new Uint8Array([0x18,0x18])).catch(()=>{});
  }
}
