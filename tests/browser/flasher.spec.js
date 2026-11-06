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
          if(text==='1' && !started){started=true;enqueue('Send data using the xmodem protocol from your terminal\r\nC');setTimeout(()=>enqueue('C'),300);return;}
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
async function startEsp(page) {
  await page.locator('#install').click();await page.locator('#ack').check();await page.locator('#wizard-start').click();
}
async function stageOne(page) {
  await page.goto('/');await startEsp(page);await expect(page.locator('#step-esp')).toContainText('✓');await expect(page.locator('#native-download')).toBeEnabled();
}
async function readReport(page) {
  await page.locator('#wizard-close').click();
  if(!await page.locator('#utilities').evaluate(e=>e.open))await page.locator('#utilities > summary').click();
  const pending=page.waitForEvent('download');await page.locator('#report').click();
  const stream=await (await pending).createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
test('landing has exactly two main actions; unsupported browser cannot start serial operations',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'serial',{value:undefined,configurable:true}));await page.goto('/');
  await expect(page.locator('.main-actions button')).toHaveCount(2);await expect(page.locator('#support')).toContainText('این مرورگر اتصال سریال ندارد');
  await expect(page.locator('#backup')).toBeDisabled();await expect(page.locator('#install')).toBeDisabled();
});
test('one backup action connects, downloads and disconnects without flashing',async({page})=>{
  await mockDevice(page);await page.goto('/');const pending=page.waitForEvent('download');await page.locator('#backup').click();
  expect((await pending).suggestedFilename()).toMatch(/^nvsfactory-/);await expect(page.locator('#status')).toContainText('ناحیه هویت خالی');
  expect(await page.evaluate(()=>window.deviceWrites)).toEqual([]);expect(await page.evaluate(()=>window.portRequests)).toBe(1);
  await expect(page.locator('#backup')).toBeEnabled();
});
test('install wizard requires consent then automatically backs up and writes sparse stock files',async({page})=>{
  await mockDevice(page);await page.goto('/');await page.locator('#install').click();await expect(page.locator('#wizard')).toBeVisible();
  await expect(page.locator('#wizard-start')).toBeDisabled();expect(await page.evaluate(()=>window.portRequests)).toBe(0);
  await page.locator('#ack').check();const pending=page.waitForEvent('download');await page.locator('#wizard-start').click();
  expect((await pending).suggestedFilename()).toMatch(/^nvsfactory-/);await expect(page.locator('#native-download')).toBeEnabled();
  expect(await page.evaluate(()=>window.deviceWrites)).toEqual([{eraseAll:false,addresses:[0,0x8000,0x3b000,0x10d000,0x110000,0x1910000,0x1a10000],md5:'900150983cd24fb0d6963f7d28e17f72'}]);
});
test('corrupted stock image is rejected before a flash write',async({page})=>{
  await mockDevice(page);await page.route('**/firmware/esp32/storage.bin',route=>route.fulfill({body:'corrupt'}));await page.goto('/');await startEsp(page);
  await expect(page.locator('#wizard-status')).toContainText('Integrity check failed');expect(await page.evaluate(()=>window.deviceWrites)).toEqual([]);
});
for(const config of [{chip:'ESP32',capacity:0x19},{chip:'ESP32-S3',capacity:0x18}]) {
  test(`rejects incompatible hardware ${config.chip} / ${config.capacity}`,async({page})=>{
    await mockDevice(page,config);await page.goto('/');await startEsp(page);await expect(page.locator('#wizard-status')).toContainText('عملیات متوقف شد');
    expect(await page.evaluate(()=>window.deviceWrites)).toEqual([]);
  });
}
test('downloading native installer does not imply successful installation; user confirmation is explicit in report',async({page})=>{
  await mockDevice(page);await stageOne(page);await expect(page.locator('#native-complete')).toBeDisabled();
  const pending=page.waitForEvent('download');await page.locator('#native-download').click();expect((await pending).suggestedFilename()).toBe('flash-himax-com7.ps1');
  await expect(page.locator('#finished-panel')).toBeHidden();expect(await page.evaluate(()=>window.himaxPackets)).toBe(0);
  await page.locator('#native-confirm').check();await page.locator('#native-complete').click();await expect(page.locator('#finished-panel')).toBeVisible();
  const report=await readReport(page);expect(report.stages.himax.state).toBe('user-confirmed-native');expect(report.stages.himax.readbackVerified).toBe(false);expect(report.stages.himax.bootloaderCompletionConfirmed).toBe(false);
});
for(const knownHimax of [false,true]) {
  test(`advanced browser transfer remains available, previously authorized Himax: ${knownHimax}`,async({page})=>{
    await mockDevice(page,{knownHimax});await stageOne(page);await page.locator('.advanced > summary').click();if(knownHimax)await page.locator('#manual-himax').uncheck();
    await page.locator('#install-himax').click();await expect(page.locator('#finished-panel')).toBeVisible();
    expect(await page.evaluate(()=>window.himaxPackets)).toBe(4288);expect(await page.evaluate(()=>window.himaxRebooted)).toBe(true);
    expect(await page.evaluate(()=>window.portRequests)).toBe(knownHimax?1:2);
  });
}
test('advanced Himax integrity failure sends no packets',async({page})=>{
  await mockDevice(page);await stageOne(page);await page.route('**/firmware/himax/*.img',route=>route.fulfill({body:'corrupt'}));
  await page.locator('.advanced > summary').click();await page.locator('#install-himax').click();await expect(page.locator('#wizard-status')).toContainText('Himax image integrity check failed');
  expect(await page.evaluate(()=>window.himaxPackets)).toBe(0);
});
test('wrong ESP32 port at Himax stage records exact error and phase',async({page})=>{
  await mockDevice(page,{wrongHimax:true});await stageOne(page);await page.locator('.advanced > summary').click();await page.locator('#install-himax').click();
  await expect(page.locator('#wizard-status')).toContainText('This is the ESP32 port');
  const report=await readReport(page);expect(report.stages.himax.state).toBe('failed');expect(report.stages.himax.phase).toBe('select-port');
  expect(report.stages.himax.error.message).toContain('This is the ESP32 port');expect(report.events.some(event=>event.message.includes('ERROR:'))).toBe(true);
});
test('previous verified report resumes at stage two with no ESP32 writes',async({page})=>{
  await mockDevice(page);await page.goto('/');await page.locator('#install').click();await page.locator('#resume-details > summary').click();
  await page.locator('#resume-file').setInputFiles({name:'previous.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({device:{eui:'2CF7F1C9647000A4'},stages:{esp32:{version:'1.1.7',verified:true,factoryPartitionPreserved:true}}}))});
  await expect(page.locator('#native-download')).toBeEnabled();await expect(page.locator('#esp-panel')).toBeHidden();expect(await page.evaluate(()=>window.deviceWrites)).toEqual([]);
});
test('dark UI and installation dialog fit mobile width',async({page})=>{
  await mockDevice(page);await page.setViewportSize({width:390,height:844});await page.goto('/');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('#install').click();
  expect(await page.locator('#wizard').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});
