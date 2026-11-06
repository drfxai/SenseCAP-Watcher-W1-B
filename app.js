import { ESPLoader, Transport } from 'esptool-js';
import { readFactory } from './flash-io.js';
import MD5 from 'crypto-js/md5.js';
import Latin1 from 'crypto-js/enc-latin1.js';
import { FACTORY_SIZE, FLASH_SIZE, validateParts, binaryString, sha256 } from './safety.js';
const $ = id => document.getElementById(id);
let loader, transport, factoryBackup, busy = false;
const supported = !!navigator.serial && window.isSecureContext;
function log(text) { $('log').textContent += `${text}\n`; $('log').scrollTop = $('log').scrollHeight; }
function status(text) { $('status').textContent = text; }
function controls() {
  $('connect').disabled = busy || !!loader || !supported;
  $('backup').disabled = busy || !loader;
  $('disconnect').disabled = busy || !loader;
  $('install').disabled = busy || !loader || !factoryBackup || !$('ack').checked;
  $('ack').disabled = busy; $('clear').disabled = busy;
}
function save(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], {type:'application/octet-stream'}));
  const link = document.createElement('a'); link.href=url; link.download=name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function release(reset = false) {
  try { if (reset && loader) await loader.after('hard_reset'); }
  finally {
    if (transport) await transport.disconnect().catch(() => {});
    loader = undefined; transport = undefined; factoryBackup = undefined;
  }
}
async function operation(fn) {
  busy = true; controls(); $('progress').value = 0;
  try { await fn(); }
  catch (error) {
    log(`ERROR: ${error.message}`);
    status('عملیات متوقف شد. گزارش را ببینید؛ کابل و پورت صحیح را بررسی و دوباره متصل شوید.');
    await release();
  } finally { busy = false; controls(); }
}
$('ack').addEventListener('change', controls);
$('connect').addEventListener('click', () => operation(async () => {
  status('انتخاب پورت و اتصال…');
  const port = await navigator.serial.requestPort();
  transport = new Transport(port, false);
  const candidate = new ESPLoader({transport, baudrate:460800, terminal:{clean(){}, write:log, writeLine:log}});
  await candidate.main();
  if (candidate.chip.CHIP_NAME !== 'ESP32-S3') throw new Error('Only ESP32-S3 is supported');
  const flashId = await candidate.readFlashId();
  if (((flashId >>> 16) & 0xff) !== 0x19) throw new Error('Expected 32 MB flash; refusing to write');
  loader = candidate;
  status('ESP32-S3 با فلش ۳۲ مگابایت متصل است. بکاپ هویت را دانلود کنید.');
}));
$('backup').addEventListener('click', () => operation(async () => {
  status('خواندن پارتیشن هویت؛ هنوز چیزی نوشته نشده…');
  const bytes = await readFactory(loader, transport, (_packet, done, total) => { $('progress').value=done/total*100; });
  if (bytes.length !== FACTORY_SIZE) throw new Error('Incomplete factory backup');
  factoryBackup = bytes;
  save(bytes, `nvsfactory-${new Date().toISOString().replace(/[:.]/g,'-')}.bin`);
  const empty = bytes.every(b => b === 255) || bytes.every(b => b === 0);
  log(`Factory backup SHA-256: ${await sha256(bytes)}`);
  status(empty ? 'بکاپ دانلود شد؛ این ناحیه خالی است. نصب، هویت قدیمی را برنمی‌گرداند.' : 'بکاپ دانلود شد؛ نگهداری کنید. وجود داده به معنی معتبر بودن اعتبارنامه‌ها نیست.');
}));
$('install').addEventListener('click', () => operation(async () => {
  if (!factoryBackup || !$('ack').checked) throw new Error('Backup and acknowledgement required');
  status('دانلود و بررسی فایل‌های اصلی…');
  const response = await fetch('firmware/manifest.json');
  if (!response.ok) throw new Error('Cannot load manifest');
  const manifest = await response.json();
  if (manifest.chip !== 'ESP32-S3' || manifest.flashSize !== FLASH_SIZE || manifest.version !== '1.1.7') throw new Error('Unexpected firmware manifest');
  validateParts(manifest.parts);
  const fileArray = [];
  for (const part of manifest.parts) {
    const res = await fetch(part.path);
    if (!res.ok) throw new Error(`Download failed: ${part.path}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== part.size || await sha256(bytes) !== part.sha256) throw new Error(`Integrity check failed: ${part.path}`);
    log(`SHA-256 OK: ${part.path}`);
    fileArray.push({address:part.offset, data:binaryString(bytes)});
  }
  if ($('clear').checked) {
    const blank = new Uint8Array(0xd2000).fill(255);
    validateParts([...manifest.parts, {offset:0x3b000,size:blank.length}]);
    fileArray.push({address:0x3b000, data:binaryString(blank)});
  }
  fileArray.sort((a,b) => a.address-b.address);
  // Check that this is still the device backed up in this connection.
  const current = await readFactory(loader, transport);
  if (await sha256(current) !== await sha256(factoryBackup)) throw new Error('Factory partition changed since backup');
  status('در حال نصب؛ کابل را جدا نکنید…');
  await loader.writeFlash({fileArray, flashSize:'keep', flashMode:'keep', flashFreq:'keep', eraseAll:false, compress:true,
    calculateMD5Hash: data => MD5(Latin1.parse(data)).toString(),
    reportProgress: (index, written, total) => { $('progress').value=((index+written/total)/fileArray.length)*100; }
  });
  const after = await readFactory(loader, transport);
  if (await sha256(after) !== await sha256(factoryBackup)) throw new Error('Factory partition verification failed. Keep the downloaded backup.');
  log('Factory partition unchanged. Firmware writes verified with MD5.');
  await release(true);
  $('progress').value=100;
  status('نصب و بررسی کامل شد؛ دستگاه راه‌اندازی شد. اتصال به SenseCraft به اعتبارنامه‌های معتبر نیاز دارد.');
}));
$('disconnect').addEventListener('click', () => operation(async () => { await release(true); status('اتصال قطع شد؛ دستگاه راه‌اندازی شد.'); }));
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue=''; } });
$('support').textContent = supported ? 'مرورگر از اتصال سریال پشتیبانی می‌کند.' : 'این مرورگر اتصال سریال ندارد. صفحه را با Chrome یا Edge دسکتاپ روی HTTPS یا localhost باز کنید.';
status('برای شروع، دستگاه را متصل کنید.'); controls();
