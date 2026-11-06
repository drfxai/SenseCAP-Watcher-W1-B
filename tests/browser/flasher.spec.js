import { test, expect } from '@playwright/test';
async function mockDevice(page, {chip='ESP32-S3',capacity=0x19}={}) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator,'serial',{value:{requestPort:async()=>({})},configurable:true});
    window.deviceWrites=[];
  });
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
