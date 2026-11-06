import { test, expect } from '@playwright/test';
async function mockDevice(page, {chip='ESP32-S3',capacity=0x19,knownHimax=false,wrongHimax=false}={}) {
  await page.addInitScript(({knownHimax,wrongHimax}) => {
    window.deviceWrites=[];window.himaxPackets=0;window.himaxRebooted=false;window.portRequests=0;
    const esp={getInfo:()=>({usbVendorId:0x1a86,usbProductId:0x55d3})};
    let controller,started=false;
    const enqueue=text=>controller.enqueue(new TextEncoder().encode(text));
    const himax={
      getInfo:()=>({usbVendorId:0x1a86,usbProductId:0x55d3}),
      async open(){
        this.readable=new ReadableStream({start(c){controller=c;}});
        this.writable=new WritableStream({write(bytes){
          const text=new TextDecoder().decode(bytes);
          if(text.includes('AT+RST')){enqueue('1. Xmodem download and burn FW image\r\n');return;}
          if(text==='1' && !started){started=true;enqueue('Send data using the xmodem protocol from your terminal\r\nC');return;}
          if(text==='1')return;
          if(text==='y'){window.himaxRebooted=true;return;}
          if(bytes.length===133 && bytes[0]===1){window.himaxPackets++;controller.enqueue(new Uint8Array([6]));return;}
          if(bytes.length===1 && bytes[0]===4){controller.enqueue(new Uint8Array([6]));enqueue('Do you want to end file transmission and reboot system?');}
        }});
      },
      async close(){}
    };
    Object.defineProperty(navigator,'serial',{value:{
      requestPort:async()=>{window.portRequests++;return window.portRequests===1 || wrongHimax ? esp : himax;},
      getPorts:async()=>knownHimax?[esp,himax]:[esp]
    },configurable:true});
  }, {knownHimax,wrongHimax});
  await page.route(/\/node_modules\/\.vite\/deps\/esptool-js\.js/, route => route.fulfill({contentType:'application/javascript',body:`
    export class Transport { async disconnect(){} async *read(){yield new Uint8Array([9, 53, 94, 107, 158, 22, 12, 239, 223, 31, 214, 118, 156, 122, 10, 211]);} }
    export class ESPLoader {
      chip={CHIP_NAME:${JSON.stringify(chip)}};
      async main(){} async readFlashId(){return ${capacity} << 16;}
      async readFlash(a,n,callback){if(callback) callback(new Uint8Array(n),n,n);return new Uint8Array(n).fill(255);}
      async writeFlash(options){window.deviceWrites.push({eraseAll:options.eraseAll, addresses:options.fileArray.map(f=>f.address), md5:options.calculateMD5Hash('abc')});options.reportProgress(0,1,1);}
      async after(){}
    }`}));
}
test('unsupported browser explains requirements and disables connection', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator,'serial',{value:undefined,configurable:true}));
  await page.goto('/');
  await expect(page.locator('#support')).toContainText('این مرورگر اتصال سریال ندارد');
  await expect(page.locator('#connect')).toBeDisabled();
});
test('requires backup and consent, then writes sparse stock files without full erase', async ({page}) => {
  await mockDevice(page);await page.goto('/');
  await page.locator('#connect').click();
  await expect(page.locator('#backup')).toBeEnabled();
  await page.locator('#ack').check();
  await expect(page.locator('#install')).toBeDisabled();
  const download=page.waitForEvent('download');await page.locator('#backup').click();
  expect((await download).suggestedFilename()).toMatch(/^nvsfactory-/);
  await expect(page.locator('#status')).toContainText('این ناحیه خالی است');
  await page.locator('#install').click();
  await expect(page.locator('#status')).toContainText('نصب و بررسی کامل شد');
  expect(await page.evaluate(()=>window.deviceWrites)).toEqual([{eraseAll:false,addresses:[0,0x8000,0x3b000,0x10d000,0x110000,0x1910000,0x1a10000],md5:'900150983cd24fb0d6963f7d28e17f72'}]);
});
test('corrupted image is rejected before any write', async ({page}) => {
  await mockDevice(page);await page.route('**/firmware/esp32/storage.bin',route=>route.fulfill({body:'corrupt'}));
  await page.goto('/');await page.locator('#connect').click();
  await page.locator('#backup').click();await page.locator('#ack').check();await page.locator('#install').click();
  await expect(page.locator('#log')).toContainText('Integrity check failed');
  expect(await page.evaluate(()=>window.deviceWrites)).toEqual([]);
});
for (const config of [{chip:'ESP32',capacity:0x19},{chip:'ESP32-S3',capacity:0x18}]) {
  test(`rejects incompatible hardware ${config.chip} / ${config.capacity}`,async({page})=>{
    await mockDevice(page,config);await page.goto('/');await page.locator('#connect').click();
    await expect(page.locator('#log')).toContainText('ERROR:');await expect(page.locator('#backup')).toBeDisabled();
    expect(await page.evaluate(()=>window.deviceWrites)).toEqual([]);
  });
}

async function stageOne(page) {
  await page.goto('/');await page.locator('#connect').click();await page.locator('#backup').click();
  await page.locator('#ack').check();await page.locator('#install').click();
  await expect(page.locator('#step-esp')).toContainText('نصب شد');
}
for(const knownHimax of [false,true]) {
  test(`two-stage browser installation, previously authorized Himax: ${knownHimax}`,async({page})=>{
    await mockDevice(page,{knownHimax});await page.goto('/');
    await page.locator('#himax-ack').check();await expect(page.locator('#install-himax')).toBeDisabled();
    await stageOne(page);await page.locator('#himax-ack').check();await page.locator('#install-himax').click();
    await expect(page.locator('#step-himax')).toContainText('نصب شد');
    expect(await page.evaluate(()=>window.himaxPackets)).toBe(4288);
    expect(await page.evaluate(()=>window.himaxRebooted)).toBe(true);
    expect(await page.evaluate(()=>window.portRequests)).toBe(knownHimax?1:2);
    const download=page.waitForEvent('download');await page.locator('#report').click();
    expect((await download).suggestedFilename()).toBe('watcher-recovery-report.json');
  });
}
test('Himax integrity failure sends no firmware packets',async({page})=>{
  await mockDevice(page);await stageOne(page);
  await page.route('**/firmware/himax/*.img',route=>route.fulfill({body:'corrupt'}));
  await page.locator('#himax-ack').check();await page.locator('#install-himax').click();
  await expect(page.locator('#log')).toContainText('Himax image integrity check failed');
  expect(await page.evaluate(()=>window.himaxPackets)).toBe(0);
});
test('choosing the ESP32 port at stage two is rejected before any transfer',async({page})=>{
  await mockDevice(page,{wrongHimax:true});await stageOne(page);
  await page.locator('#himax-ack').check();await page.locator('#install-himax').click();
  await expect(page.locator('#log')).toContainText('This is the ESP32 port');
  expect(await page.evaluate(()=>window.himaxPackets)).toBe(0);
});
