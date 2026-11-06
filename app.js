import { verifiedPreviousStage } from './recovery-report.js';
import { SerialChannel, HimaxFlasher, HIMAX_SIZE, HIMAX_SHA256 } from './himax.js';
import { ESPLoader, Transport } from 'esptool-js';
import { readFactory } from './flash-io.js';
import MD5 from 'crypto-js/md5.js';
import Latin1 from 'crypto-js/enc-latin1.js';
import { FACTORY_SIZE, FLASH_SIZE, validateParts, binaryString, sha256 } from './safety.js';
const $ = id => document.getElementById(id);
let loader, transport, factoryBackup, busy = false;
let espPort, espCompleted = false, himaxCompleted = false, himaxChannel, himaxFlasher, himaxAbort;
let profile;
const report = { esp32: null, himax: null };
const events=[];
function phase(value) {if(report.himax)report.himax.phase=value;}
const supported = !!navigator.serial && window.isSecureContext;
function log(text) { events.push({time:new Date().toISOString(),message:String(text)});if(events.length>300)events.shift(); $('log').textContent += `${text}\n`; $('log').scrollTop = $('log').scrollHeight; }
function status(text) { $('status').textContent = text; }
function controls() {
  $('connect').disabled = busy || !!loader || !supported;
  $('backup').disabled = busy || !loader;
  $('disconnect').disabled = busy || !loader;
  $('install').disabled = busy || !loader || !factoryBackup || !$('ack').checked;
  $('resume-file').disabled=busy || !supported;
  $('manual-himax').disabled=busy;
  $('ack').disabled = busy; $('clear').disabled = busy;
  $('install-himax').disabled = busy || !espCompleted || !supported || !$('himax-ack').checked;
  $('himax-ack').disabled = busy;
  $('cancel-himax').disabled = !himaxAbort || himaxAbort.signal.aborted;
  $('report').disabled = busy || !espCompleted;
  $('step-esp').textContent = espCompleted ? 'مرحله ۱: ESP32-S3 نصب شد ✓' : 'مرحله ۱: ESP32-S3';
  $('step-himax').textContent = himaxCompleted ? 'مرحله ۲: Himax نصب شد ✓' : 'مرحله ۲: Himax';
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
  espCompleted=false;himaxCompleted=false;report.esp32=null;report.himax=null;espPort=port;
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
  espCompleted=true;
  report.esp32={version:manifest.version,verified:true,factoryPartitionPreserved:true,completedAt:new Date().toISOString()};
  await release(true);
  $('progress').value=100;
  status('نصب و بررسی کامل شد؛ مرحله ۱ تمام شد. اکنون پورت دیگر را برای نصب Himax در مرحله ۲ انتخاب کنید.');
  $('himax-status').textContent='مرحله اول موفق بود. برای شروع مرحله دوم آماده‌اید.';
  $('himax').scrollIntoView({behavior:'smooth',block:'start'});
}));
$('disconnect').addEventListener('click', () => operation(async () => { await release(true); status('اتصال قطع شد؛ دستگاه راه‌اندازی شد.'); }));
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue=''; } });
$('support').textContent = supported ? 'مرورگر از اتصال سریال پشتیبانی می‌کند.' : 'این مرورگر اتصال سریال ندارد. صفحه را با Chrome یا Edge دسکتاپ روی HTTPS یا localhost باز کنید.';
status('برای شروع، دستگاه را متصل کنید.'); controls();

$('himax-ack').addEventListener('change', controls);
$('install-himax').addEventListener('click', () => operation(async () => {
  if(!espCompleted || !$('himax-ack').checked)throw new Error('Complete ESP32 stage first');
  himaxCompleted=false;
  report.himax={state:'running',phase:'select-port',startedAt:new Date().toISOString(),bytesAcknowledged:0};
  $('himax-progress').value=0;
  $('himax-status').textContent='در حال انتخاب پورت مخصوص Himax…';
  try {
    const granted=await navigator.serial.getPorts();
    const candidates=granted.filter(port=> {
      const info=port.getInfo();
      return port!==espPort && info.usbVendorId===0x1a86 && [0x55d2,0x55d3].includes(info.usbProductId);
    });
    const port=!$('manual-himax').checked && espPort && candidates.length===1 ? candidates[0] : await navigator.serial.requestPort();
    if(port===espPort)throw new Error('This is the ESP32 port. Select the other Watcher UART for Himax.');
    report.himax.port=port.getInfo();
    await release();phase('download-image');
    status('مرحله ۲: دانلود و بررسی فایل اصلی Himax…');
    const res=await fetch('firmware/himax/himax_firmware_20240816.img');
    if(!res.ok)throw new Error('Cannot download Himax factory image');
    const bytes=new Uint8Array(await res.arrayBuffer());
    if(bytes.length!==HIMAX_SIZE || await sha256(bytes)!==HIMAX_SHA256)throw new Error('Himax image integrity check failed; nothing written');
    log('Himax stock image SHA-256 verified.');
    himaxAbort=new AbortController();controls();
    phase('open-port');himaxChannel=new SerialChannel(port);await himaxChannel.open();
    himaxFlasher=new HimaxFlasher(himaxChannel,{signal:himaxAbort.signal,log,progress:(done,total)=>{report.himax.bytesAcknowledged=done;$('progress').value=done/total*100;$('himax-progress').value=done/total*100;}});
    $('himax-status').textContent='در انتظار بوت‌لودر Himax؛ اگر پاسخی نیامد، دستگاه را با دکمه سخت‌افزاری ریست کنید. کابل را جدا نکنید.';
    status('مرحله ۲: شناسایی بوت‌لودر Himax…');
    phase('bootloader-handshake');await himaxFlasher.connect();
    $('himax-status').textContent='بوت‌لودر Himax تأیید شد؛ فایل اصلی در حال نصب است. کابل را جدا نکنید.';
    status('مرحله ۲: ارسال فریمور Himax با XMODEM-CRC…');
    phase('transfer-image');await himaxFlasher.flash(bytes);
    himaxCompleted=true;
    report.himax={...report.himax,state:'success',phase:'complete',file:'himax_firmware_20240816.img',sha256:HIMAX_SHA256,transfer:'XMODEM-CRC128',bootloaderCompletionConfirmed:true,readbackVerified:false,completedAt:new Date().toISOString()};
    $('himax-progress').value=100;
    $('himax-status').textContent='مرحله ۲ کامل شد؛ دریافت فایل و پایان عملیات توسط بوت‌لودر Himax تأیید شد.';
    status('هر دو مرحله نصب تمام شد. برای اتصال SenseCraft، اطلاعات معتبر کارخانه همچنان لازم است.');
  } catch(error) {
    report.himax={...report.himax,state:himaxAbort?.signal.aborted?'cancelled':'failed',error:{name:error.name,message:error.message},bootloaderRecognized:himaxFlasher?.recognized || false,lastBootloaderText:himaxFlasher?.tail || '',failedAt:new Date().toISOString()};
    $('manual-himax').checked=true;
    await himaxFlasher?.cancel();
    $('himax-status').textContent='مرحله Himax کامل نشد. گزارش را ببینید؛ در صورت قطع انتقال، پس از ریست همین مرحله را دوباره اجرا کنید.';
    throw error;
  } finally {
    await himaxChannel?.close();himaxChannel=undefined;himaxFlasher=undefined;himaxAbort=undefined;
  }
}));
$('cancel-himax').addEventListener('click',()=>{
  himaxAbort?.abort();$('himax-status').textContent='در حال توقف مرحله Himax…';controls();
});
$('report').addEventListener('click',()=>{
  const result={schemaVersion:2,flasherVersion:'1.4.0',device:profile || null,stages:report,events,browser:navigator.userAgent,factoryCredentialsRestored:false};
  save(new TextEncoder().encode(JSON.stringify(result,null,2)+'\n'),'watcher-recovery-report.json');
});
fetch('device-profile.json').then(response=>{if(!response.ok)throw new Error('Profile unavailable');return response.json();}).then(value=>{
  profile=value;$('device-eui').textContent=value.eui;$('device-sn').textContent=value.serialNumber;
}).catch(error=>log(error.message));

$('resume-file').addEventListener('change',()=>operation(async()=>{
  const file=$('resume-file').files[0];if(!file)return;
  if(file.size>2*1024*1024)throw new Error('Recovery report is too large');
  const previous=JSON.parse(await file.text());
  const reference=profile || await (await fetch('device-profile.json')).json();
  const stage=verifiedPreviousStage(previous,reference.eui);
  await release();espPort=undefined;espCompleted=true;himaxCompleted=false;
  report.esp32=stage;report.himax=null;$('manual-himax').checked=true;
  log('Verified previous ESP32 report imported; ESP32 will not be flashed again. Select the other UART of the same device.');
  status('گزارش مرحله ۱ وارد شد. اکنون فقط مرحله Himax را روی همان دستگاه اجرا کنید.');
  $('himax-status').textContent='آماده ادامه از گزارش قبلی؛ پورت Himax همان دستگاه را دستی انتخاب کنید.';
  $('himax').scrollIntoView({behavior:'smooth'});
}));
