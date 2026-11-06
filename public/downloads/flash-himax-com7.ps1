# Native Himax recovery for the owner's Watcher: COM6 = ESP32, COM7 = Himax.
# Uses the official Seeed python-sscma tool. Does not flash ESP32 or write a SN.
param(
    [ValidatePattern('^COM\d+$')]
    [string]$Port = 'COM7'
)
$ErrorActionPreference = 'Stop'
if ($Port -eq 'COM6') { throw 'COM6 is the ESP32 port on this device. Use COM7 for Himax.' }
if ([System.IO.Ports.SerialPort]::GetPortNames() -notcontains $Port) { throw "$Port not found. Check Device Manager." }
$Python = if (Get-Command py -ErrorAction SilentlyContinue) { 'py' } elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { throw 'Python was not found. Install Python and restart PowerShell.' }

Write-Host 'Close the browser flasher and all serial monitors before continuing.'
Write-Host "Only $Port will be passed to the Himax tool. ESP32 will not be flashed."
& $Python -m pip install python-sscma==0.5.7
if ($LASTEXITCODE -ne 0) { throw 'python-sscma installation failed.' }

$WorkDir = Join-Path $env:TEMP 'watcher-himax-recovery'
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$Firmware = Join-Path $WorkDir 'himax_factory.img'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing 'https://drfxai.github.io/SenseCAP-Watcher-W1-B/firmware/himax/himax_firmware_20240816.img' -OutFile $Firmware
$Expected = '55AB2BCAEE3BF6E0FAD149BB06B36139610BB5578847B94C59937EB32875D0FD'
if ((Get-Item $Firmware).Length -ne 548864 -or (Get-FileHash $Firmware -Algorithm SHA256).Hash -ne $Expected) {
    throw 'Firmware size or SHA-256 mismatch. Nothing was flashed.'
}
# Recheck just before starting: the upstream CLI can otherwise select another
# enumerated port if the requested port has disappeared.
if ([System.IO.Ports.SerialPort]::GetPortNames() -notcontains $Port) { throw "$Port disconnected. Nothing was flashed." }
Write-Host 'Factory image SHA-256 verified.'
Write-Host 'When waiting for the bootloader, press the device hardware reset button.'
Write-Host 'Keep the cable connected until the tool finishes.'
& $Python -m sscma.cli.cli flasher -p $Port -b 921600 -f $Firmware
if ($LASTEXITCODE -ne 0) { throw 'The Himax tool returned a failure exit code.' }
# Upstream catches some errors without a nonzero exit code. Never infer success
# from $LASTEXITCODE alone. The user must check the visible output.
Write-Host ''
Write-Host 'The tool has exited. Confirm 100% progress and no Error/Traceback above.'
Write-Host 'This is not a flash-readback check or proof of restored SenseCraft credentials.'
