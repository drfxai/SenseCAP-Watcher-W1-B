#!/usr/bin/env python3
"""Verify the pinned stock package before builds and CLI writes."""
import hashlib
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    'bootloader/bootloader.bin': 0,
    'partition_table/partition-table.bin': 0x8000,
    'ota_data_initial.bin': 0x10D000,
    'factory_firmware.bin': 0x110000,
    'srmodels/srmodels.bin': 0x1910000,
    'storage.bin': 0x1A10000,
}

def verify(root=ROOT):
    manifest = json.loads((root / 'public/firmware/manifest.json').read_text())
    assert manifest['upstreamCommit'] == '3ca69aefa8441f57d38993a39df714048633d032'
    assert manifest['version'] == '1.1.7'
    assert len(manifest['parts']) == len(EXPECTED)
    ranges = []
    for part in [*manifest['parts'], manifest['himax']]:
        data = (root / 'public' / part['path']).read_bytes()
        assert len(data) == part['size'], part['path']
        assert hashlib.sha256(data).hexdigest() == part['sha256'], part['path']
        if 'offset' not in part:
            continue
        rel = part['path'].removeprefix('firmware/esp32/')
        assert part['offset'] == EXPECTED[rel], rel
        start = part['offset'] // 4096 * 4096
        end = (part['offset'] + len(data) + 4095) // 4096 * 4096
        assert end <= 32 * 1024 * 1024
        assert not (start < 0x3B000 and end > 0x9000), 'Factory overlap'
        assert not any(start < b and end > a for a, b in ranges), 'Sector overlap'
        ranges.append((start, end))
    table = (root / 'public/firmware/esp32/partition_table/partition-table.bin').read_bytes()
    partitions = {}
    for off in range(0, len(table), 32):
        if table[off:off+2] != b'\xaaP':
            break
        _, _, _, start, size, label, _ = struct.unpack('<HBBII16sI', table[off:off+32])
        partitions[label.rstrip(b'\0').decode()] = (start, size)
    assert partitions['nvsfactory'] == (0x9000, 0x32000)
    assert partitions['nvs'] == (0x3B000, 0xD2000)
    assert partitions['ota_0'] == (0x110000, 0xC00000)
    for name in ['bootloader/bootloader.bin', 'factory_firmware.bin']:
        data = (root / 'public/firmware/esp32' / name).read_bytes()
        assert data[2:4] == b'\x02\x5f', 'Expected DIO / 32 MB / 80 MHz header'
        assert data[0] == 0xE9 and struct.unpack_from('<H', data, 12)[0] == 9, 'Not ESP32-S3 image'
    return manifest

if __name__ == '__main__':
    m = verify()
    print(f"Verified {len(m['parts'])} ESP32 images + Himax, SHA-256, ESP32-S3 headers, partitions and protected factory sectors.")
