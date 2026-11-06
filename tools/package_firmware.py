#!/usr/bin/env python3
"""Create a reproducible multi-image factory recovery ZIP; never a padded BIN."""
from pathlib import Path
import zipfile
from verify_firmware import ROOT, verify

verify()
out = ROOT / 'public/downloads'
out.mkdir(exist_ok=True)
files = [*sorted((ROOT / 'public/firmware').rglob('*')), ROOT / 'LICENSE', ROOT / 'README.md', *sorted((ROOT / 'tools').glob('*.py')), ROOT / 'requirements.txt']
with zipfile.ZipFile(out / 'watcher-factory-1.1.7.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in files:
        if file.is_file():
            name = str(file.relative_to(ROOT))
            info = zipfile.ZipInfo(name, (2024, 10, 24, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, file.read_bytes())
print(out / 'watcher-factory-1.1.7.zip')
