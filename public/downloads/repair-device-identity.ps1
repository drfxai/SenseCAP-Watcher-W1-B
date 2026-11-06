# Identity-only repair for the exact owner-supplied 204800-byte backup.
# Does NOT flash hardware. Does NOT reconstruct cloud credentials.
# Original private Wi-Fi/legacy bytes stay on the user's computer.
param(
    [Parameter(Mandatory=$true)][string]$InputFile,
    [string]$OutputFile = 'nvsfactory-W1-B-identity-fixed.bin'
)
$ErrorActionPreference = 'Stop'
$InputPath = (Resolve-Path -LiteralPath $InputFile).Path
if ((Get-Item -LiteralPath $InputPath).Length -ne 204800) { throw 'Expected a 204800-byte nvsfactory backup.' }
if ((Get-FileHash -LiteralPath $InputPath -Algorithm SHA256).Hash -ne 'A278E722FFECB09FE8251B1AC2D0B8EC1D803FB0E5041116C6D093729A6B97F5') {
    throw 'This patch is only for the exact backup supplied by the owner. Nothing was changed.'
}
if (Test-Path -LiteralPath $OutputFile) { throw 'Output file already exists. Use a different -OutputFile or retain/remove the older output first.' }
$Bytes = [IO.File]::ReadAllBytes($InputPath)
[Convert]::FromBase64String('qqqqqqr+//////////////////////////////////8=').CopyTo($Bytes, 4128)
[Convert]::FromBase64String('AAEB/6xBUedkZXZpY2VfaW5mbwAAAAAABP////////8EIQL/629l3FNOX1NLAAAAAAAAAAAAAAATAP//eNZBCTExMzk5MTI3NTI0NDcwMDE2NQD/////////////////BCEC/6q8ha1FVUlfU0sAAAAAAAAAAAAAEQD//8QJX9QyQ0Y3RjFDOTY0NzAwMEE0AP///////////////////wQhAv+MiiuvQ09ERV9TSwAAAAAAAAAAABEA//8u9ekHRTJCNkI4QTQ3NkM4RDc2QwD///////////////////8EIQL/XTiaTERFVl9LRVlfU0sAAAAAAAABAP///////wD/////////////////////////////////////////BCEC/2HTLDxCQVRDSElEX1NLAAAAAAAAAQD///////8A/////////////////////////////////////////wQhAv8OFwVlQUNDRVNTX0tFWV9TSwAAAAEA////////AP////////////////////////////////////////8EIQL/i70Go0FJX0tFWV9TSwAAAAAAAAABAP///////wD/////////////////////////////////////////BCEC/ygR1L5ERVZfQ1RMX0tFWV9TSwAAAQD///////8A/////////////////////////////////////////wQhAv9IpEmEUExBVEZPUk1fU0sAAAAAAAEA////////AP////////////////////////////////////////8=').CopyTo($Bytes, 4224)
[IO.File]::WriteAllBytes([IO.Path]::GetFullPath($OutputFile), $Bytes)
if ((Get-FileHash -LiteralPath $OutputFile -Algorithm SHA256).Hash -ne '18DFF19B2BCDB1A7501DB115F52EC9F841BF6E9DA3C3FC0A98280D8BB3813FE7') {
    throw 'Output checksum mismatch. Do not flash this file.'
}
Write-Host 'Identity repair file created and SHA-256 verified.'
Write-Host 'EUI: 2CF7F1C9647000A4'
Write-Host 'S/N: 113991275244700165'
Write-Host ([IO.Path]::GetFullPath($OutputFile))
Write-Host 'All pre-existing bytes outside the unused entries/bitmap were preserved.'
Write-Host 'Missing cloud credentials remain empty. This is not a full factory provisioning recovery.'
Write-Host 'The output retains original private NVS data. Do not publish the output BIN.'
