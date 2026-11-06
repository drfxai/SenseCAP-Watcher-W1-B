#!/usr/bin/env python3
"""Stock ESP32 restore using esptool 4.8.1. Never performs erase_flash."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
import sys
from verify_firmware import ROOT, verify

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', required=True, help='ESP32 serial port, e.g. COM5 or /dev/ttyACM0')
parser.add_argument('--baud', type=int, default=460800)
parser.add_argument('--keep-settings', action='store_true', help='Do not reset ordinary NVS settings')
args = parser.parse_args()
manifest = verify()
base = [sys.executable, '-m', 'esptool', '--chip', 'esp32s3', '--port', args.port, '--baud', str(args.baud)]
def run(*arguments):
    subprocess.run([*base, *arguments], check=True)

print('Use only on SenseCAP Watcher with 32 MB flash. Missing credentials cannot be regenerated.')
identity = subprocess.run([*base, 'flash_id'], check=True, capture_output=True, text=True)
print(identity.stdout)
if not re.search(r'Detected flash size:\s*32MB\b', identity.stdout):
    sys.exit('Expected 32 MB flash; refusing to write.')
# Preserve a private, timestamped backup outside the source tree.
backup_dir = Path.cwd() / 'watcher-backups'
backup_dir.mkdir(mode=0o700, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup = backup_dir / f'nvsfactory-{stamp}.bin'
run('read_flash', '0x9000', '0x32000', str(backup))
assert backup.stat().st_size == 0x32000, 'Incomplete backup; refusing to flash'
backup.chmod(0o600)
print(f'Factory backup: {backup.resolve()} — keep private, even if the partition appears empty.')
files = []
for part in manifest['parts']:
    files.extend([hex(part['offset']), str(ROOT / 'public' / part['path'])])
# esptool writes separate ranges; no padded merged binary and no full erase.
if not args.keep_settings:
    blank = backup_dir / f'blank-settings-{stamp}.bin'
    blank.write_bytes(b'\xff' * 0xD2000)
    files.extend(['0x3b000', str(blank)])
try:
    run('write_flash', '--flash_mode', 'dio', '--flash_size', '32MB', '--flash_freq', '80m', *files)
    after = backup_dir / f'nvsfactory-after-{stamp}.bin'
    run('read_flash', '0x9000', '0x32000', str(after))
    assert after.read_bytes() == backup.read_bytes(), 'Factory partition changed; retain original backup!'
    print('Firmware verified by esptool. Factory partition unchanged.')
finally:
    if not args.keep_settings:
        blank.unlink(missing_ok=True)
