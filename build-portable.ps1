$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
# Coordinate shared-host benchmark windows before running this script.
cargo test --offline -j 1
if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed' }
cargo build --release --offline -j 1
if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$package = Join-Path $PSScriptRoot "dist\ClearAudio-$stamp"
New-Item -ItemType Directory -Path $package | Out-Null
Copy-Item -LiteralPath 'target\release\clear-audio.exe','README.md','VALIDATION.md','MANUAL-TESTS.md','THIRD-PARTY-NOTICES.txt' -Destination $package
Copy-Item -LiteralPath 'extension' -Destination $package -Recurse
Compress-Archive -LiteralPath $package -DestinationPath "$package-win64.zip"
Get-FileHash -LiteralPath "$package-win64.zip" -Algorithm SHA256
