#!/usr/bin/env python3
"""Create a reproducible multi-image factory recovery ZIP; never a padded BIN."""
from pathlib import Path
import zipfile
import shutil
from verify_firmware import ROOT, verify

verify()
out = ROOT / 'public/downloads'
out.mkdir(exist_ok=True)
shutil.copyfile(ROOT / 'tools/flash-himax.ps1', out / 'flash-himax-com7.ps1')
shutil.copyfile(ROOT / 'tools/repair-device-identity.ps1', out / 'repair-device-identity.ps1')
files = [*sorted((ROOT / 'public/firmware').rglob('*')), ROOT / 'LICENSE', ROOT / 'README.md', *sorted(p for p in (ROOT / 'tools').iterdir() if p.suffix in {'.py', '.ps1'}), ROOT / 'requirements.txt', ROOT / 'public/device-profile.json', *sorted((ROOT / 'public/validation').glob('*.json')), *sorted((ROOT / 'docs').rglob('*.md'))]
with zipfile.ZipFile(out / 'watcher-factory-1.1.7.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in files:
        if file.is_file():
            name = str(file.relative_to(ROOT))
            info = zipfile.ZipInfo(name, (2024, 10, 24, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, file.read_bytes())
print(out / 'watcher-factory-1.1.7.zip')
