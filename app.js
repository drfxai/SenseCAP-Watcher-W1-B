import { verifiedPreviousStage } from './recovery-report.js';
import { SerialChannel, HimaxFlasher, HIMAX_SIZE, HIMAX_SHA256 } from './himax.js';
import { ESPLoader, Transport } from 'esptool-js';
import { readFactory } from './flash-io.js';
import MD5 from 'crypto-js/md5.js';
import Latin1 from 'crypto-js/enc-latin1.js';
import { FACTORY_SIZE, FLASH_SIZE, validateParts, binaryString, sha256 } from './safety.js';
const $ = id => document.getElementById(id);
const supported = !!navigator.serial && window.isSecureContext;
const report = {esp32:null,himax:null}, events=[];
let loader, transport, espPort, factoryBackup, profile;
let busy=false, espCompleted=false, himaxCompleted=false, himaxAbort, himaxChannel, himaxFlasher;
function log(message) {
  events.push({time:new Date().toISOString(),message:String(message)});
  if(events.length>300)events.shift();
  $('log').textContent+=`${message}\n`; $('log').scrollTop=$('log').scrollHeight;
}
function setProgress(value) { $('progress').value=value; $('wizard-progress').value=value; }
function status(message) { $('status').textContent=message; $('wizard-status').textContent=message; }
function controls() {
  $('backup').disabled=busy || !supported; $('install').disabled=busy || !supported;
  $('wizard-start').disabled=busy || !$('ack').checked || !supported;
  $('wizard-close').disabled=busy; $('ack').disabled=busy;
  $('resume-file').disabled=busy || !supported;
  $('native-download').disabled=busy || !espCompleted;
  $('native-confirm').disabled=busy;
  $('native-complete').disabled=busy || !espCompleted || !$('native-confirm').checked;
  $('install-himax').disabled=busy || !espCompleted || !supported;
  $('manual-himax').disabled=busy;
  $('cancel-himax').disabled=!himaxAbort || himaxAbort.signal.aborted;
  $('report').disabled=busy || !espCompleted;
  $('step-esp').textContent=espCompleted?'۱ · ESP32-S3 ✓':'۱ · ESP32-S3';
  $('step-himax').textContent=himaxCompleted?'۲ · Himax ✓':'۲ · Himax';
  $('step-esp').className=espCompleted?'done':'current';
  $('step-himax').className=himaxCompleted?'done':espCompleted?'current':'';
  $('esp-panel').hidden=espCompleted;
  $('himax-panel').hidden=!espCompleted || himaxCompleted;
  $('finished-panel').hidden=!himaxCompleted;
  $('resume-details').hidden=busy || himaxCompleted;
}
function save(bytes,name) {
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
  const link=document.createElement('a');link.href=url;link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function release(reset=false) {
  try {if(reset && loader)await loader.after('hard_reset');}
  finally {if(transport)await transport.disconnect().catch(()=>{});loader=undefined;transport=undefined;factoryBackup=undefined;}
}
async function operation(fn) {
  if(busy)return;
  busy=true;controls();setProgress(0);
  try {await fn();}
  catch(error) {
    log(`ERROR: ${error.message}`);status(`عملیات متوقف شد: ${error.message}`);
    $('utilities').open=true;$('log-details').open=true;
    await release(true).catch(()=>{});
  } finally {busy=false;controls();}
}
async function connectEsp() {
  const port=await navigator.serial.requestPort();espPort=port;
  status('در حال اتصال به ESP32-S3…');
  transport=new Transport(port,false);
  const candidate=new ESPLoader({transport,baudrate:460800,terminal:{clean(){},write:log,writeLine:log}});
  await candidate.main();
  if(candidate.chip.CHIP_NAME!=='ESP32-S3')throw new Error('Only ESP32-S3 is supported');
  if((((await candidate.readFlashId())>>>16)&255)!==0x19)throw new Error('Expected 32 MB flash; refusing to write');
  loader=candidate;
}
async function backupFactory() {
  status('در حال خواندن بکاپ…');
  const bytes=await readFactory(loader,transport,(_packet,done,total)=>{setProgress(done/total*100);});
  if(bytes.length!==FACTORY_SIZE)throw new Error('Incomplete factory backup');
  factoryBackup=bytes;save(bytes,`nvsfactory-${new Date().toISOString().replace(/[:.]/g,'-')}.bin`);
  log(`Factory backup SHA-256: ${await sha256(bytes)}`);
  return bytes.every(b=>b===255) || bytes.every(b=>b===0);
}
async function flashEsp() {
  if(!factoryBackup)throw new Error('Verified backup required');
  status('بررسی فایل‌های اصلی…');
  const response=await fetch('firmware/manifest.json');
  if(!response.ok)throw new Error('Cannot load manifest');
  const manifest=await response.json();
  if(manifest.chip!=='ESP32-S3' || manifest.flashSize!==FLASH_SIZE || manifest.version!=='1.1.7')throw new Error('Unexpected firmware manifest');
  validateParts(manifest.parts);
  const fileArray=[];
  for(const part of manifest.parts) {
    const res=await fetch(part.path);if(!res.ok)throw new Error(`Download failed: ${part.path}`);
    const bytes=new Uint8Array(await res.arrayBuffer());
    if(bytes.length!==part.size || await sha256(bytes)!==part.sha256)throw new Error(`Integrity check failed: ${part.path}`);
    log(`SHA-256 OK: ${part.path}`);fileArray.push({address:part.offset,data:binaryString(bytes)});
  }
  const blank=new Uint8Array(0xd2000).fill(255);
  validateParts([...manifest.parts,{offset:0x3b000,size:blank.length}]);
  fileArray.push({address:0x3b000,data:binaryString(blank)});fileArray.sort((a,b)=>a.address-b.address);
  const current=await readFactory(loader,transport);
  if(await sha256(current)!==await sha256(factoryBackup))throw new Error('Factory partition changed since backup');
  status('مرحله ۱: نصب ESP32-S3؛ کابل را جدا نکنید.');
  await loader.writeFlash({fileArray,flashSize:'keep',flashMode:'keep',flashFreq:'keep',eraseAll:false,compress:true,
    calculateMD5Hash:data=>MD5(Latin1.parse(data)).toString(),
    reportProgress:(index,written,total)=>{setProgress((index+written/total)/fileArray.length*100);}
  });
  const after=await readFactory(loader,transport);
  if(await sha256(after)!==await sha256(factoryBackup))throw new Error('Factory partition verification failed. Keep your backup.');
  log('Factory partition unchanged. Firmware writes verified with MD5.');
  report.esp32={version:manifest.version,verified:true,factoryPartitionPreserved:true,completedAt:new Date().toISOString()};
  espCompleted=true;await release(true);setProgress(100);
  status('مرحله اول تمام شد؛ اکنون Himax.');
}
$('backup').addEventListener('click',()=>operation(async()=>{
  await connectEsp();const empty=await backupFactory();await release(true);setProgress(100);
  status(empty?'بکاپ ذخیره شد؛ ناحیه هویت خالی است.':'بکاپ دستگاه ذخیره شد.');
}));
$('install').addEventListener('click',()=>{controls();$('wizard').showModal();});
$('wizard-close').addEventListener('click',()=>{if(!busy)$('wizard').close();});
$('wizard').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
$('ack').addEventListener('change',controls);
$('wizard-start').addEventListener('click',()=>operation(async()=>{
  if(!$('ack').checked)throw new Error('Installation acknowledgement required');
  report.esp32=null;report.himax=null;espCompleted=false;himaxCompleted=false;
  await connectEsp();await backupFactory();await flashEsp();
}));
$('native-download').addEventListener('click',()=>{
  const link=document.createElement('a');link.href='downloads/flash-himax-com7.ps1';link.download='flash-himax-com7.ps1';link.click();
  log('Official Himax PowerShell installer downloaded; no native installation has been verified by the browser.');
  status('نصب‌کننده Himax دریافت شد؛ آن را در PowerShell اجرا کنید.');
});
$('native-confirm').addEventListener('change',controls);
$('native-complete').addEventListener('click',()=>{
  if(!espCompleted || !$('native-confirm').checked)return;
  report.himax={state:'user-confirmed-native',method:'python-sscma 0.5.7 / PowerShell',port:'COM7',sha256:HIMAX_SHA256,confirmationSource:'user',readbackVerified:false,bootloaderCompletionConfirmed:false,completedAt:new Date().toISOString()};
  himaxCompleted=true;setProgress(100);$('completion-note').textContent='پایان Himax طبق تأیید شما ثبت شد؛ مرورگر نصب PowerShell را بررسی نکرده است.';
  log('User confirmed native Himax transfer reached 100% with no displayed error.');status('پایان نصب طبق گزارش شما ثبت شد.');controls();
});
$('resume-file').addEventListener('change',()=>operation(async()=>{
  const file=$('resume-file').files[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('Recovery report is too large');
  const reference=profile || await (await fetch('device-profile.json')).json();
  const stage=verifiedPreviousStage(JSON.parse(await file.text()),reference.eui);
  await release(true);espPort=undefined;espCompleted=true;himaxCompleted=false;report.esp32=stage;report.himax=null;
  $('manual-himax').checked=true;$('himax-status').textContent='گزارش مرحله اول وارد شد؛ فقط Himax باقی مانده است.';
  log('Verified previous ESP32 report imported; ESP32 will not be flashed again.');status('گزارش وارد شد؛ نصب مجدد ESP32 لازم نیست.');
}));
$('report').addEventListener('click',()=>{
  save(new TextEncoder().encode(JSON.stringify({schemaVersion:3,flasherVersion:'2.0.0',device:profile || null,stages:report,events,browser:navigator.userAgent,factoryCredentialsRestored:false},null,2)+'\n'),'watcher-recovery-report.json');
});
$('install-himax').addEventListener('click',()=>operation(async()=>{
  if(!espCompleted)throw new Error('Complete ESP32 stage first');
  himaxCompleted=false;report.himax={state:'running',phase:'select-port',startedAt:new Date().toISOString(),bytesAcknowledged:0};
  $('himax-progress').value=0;
  try {
    const granted=await navigator.serial.getPorts();
    const candidates=granted.filter(port=>{const info=port.getInfo();return port!==espPort && info.usbVendorId===0x1a86 && [0x55d2,0x55d3].includes(info.usbProductId);});
    const port=!$('manual-himax').checked && espPort && candidates.length===1?candidates[0]:await navigator.serial.requestPort();
    if(port===espPort)throw new Error('This is the ESP32 port. Select the other Watcher UART for Himax.');
    report.himax.port=port.getInfo();await release(true);report.himax.phase='download-image';
    const res=await fetch('firmware/himax/himax_firmware_20240816.img');if(!res.ok)throw new Error('Cannot download Himax factory image');
    const bytes=new Uint8Array(await res.arrayBuffer());
    if(bytes.length!==HIMAX_SIZE || await sha256(bytes)!==HIMAX_SHA256)throw new Error('Himax image integrity check failed; nothing written');
    log('Himax stock image SHA-256 verified.');himaxAbort=new AbortController();controls();
    report.himax.phase='open-port';himaxChannel=new SerialChannel(port);await himaxChannel.open();
    himaxFlasher=new HimaxFlasher(himaxChannel,{signal:himaxAbort.signal,log,progress:(done,total)=>{report.himax.bytesAcknowledged=done;setProgress(done/total*100);$('himax-progress').value=done/total*100;}});
    status('در انتظار Himax؛ در صورت نیاز دکمه ریست را بزنید.');
    report.himax.phase='bootloader-handshake';await himaxFlasher.connect();
    status('مرحله ۲: نصب Himax؛ کابل را جدا نکنید.');report.himax.phase='transfer-image';await himaxFlasher.flash(bytes);
    report.himax={...report.himax,state:'success',phase:'complete',file:'himax_firmware_20240816.img',sha256:HIMAX_SHA256,transfer:'XMODEM-CRC128',bootloaderCompletionConfirmed:true,readbackVerified:false,completedAt:new Date().toISOString()};
    himaxCompleted=true;$('himax-progress').value=100;
    $('completion-note').textContent='انتقال و پیام پایان بوت‌لودر تأیید شد؛ بازخوانی کامل فلش انجام نشده است.';status('نصب هر دو مرحله کامل شد.');
  } catch(error) {
    report.himax={...report.himax,state:himaxAbort?.signal.aborted?'cancelled':'failed',error:{name:error.name,message:error.message},bootloaderRecognized:himaxFlasher?.recognized || false,lastBootloaderText:himaxFlasher?.tail || '',failedAt:new Date().toISOString()};
    $('manual-himax').checked=true;await himaxFlasher?.cancel();throw error;
  } finally {await himaxChannel?.close();himaxChannel=undefined;himaxFlasher=undefined;himaxAbort=undefined;}
}));
$('cancel-himax').addEventListener('click',()=>{himaxAbort?.abort();status('در حال توقف Himax…');controls();});
window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
fetch('device-profile.json').then(response=>{if(!response.ok)throw new Error('Profile unavailable');return response.json();}).then(value=>{profile=value;$('device-eui').textContent=value.eui;$('device-sn').textContent=value.serialNumber;}).catch(error=>log(error.message));
$('support').textContent=supported?'آماده اتصال':'این مرورگر اتصال سریال ندارد';controls();
