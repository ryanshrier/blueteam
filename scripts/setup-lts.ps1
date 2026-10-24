# Install the pinned official runtime for this application and rebuild native
# dependencies with its bundled npm. No system runtime/process is replaced.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot '.node-version') -Raw).Trim()
if ($version -notmatch '^24\.\d+\.\d+$') { throw 'Expected a pinned Node24 LTS version.' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.runtime'))
if (-not $runtimeRoot.StartsWith([IO.Path]::GetFullPath($projectRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime path is outside this project.' }
$archiveName = "node-v$version-win-$arch.zip"
$runtime = Join-Path $runtimeRoot "node-v$version-win-$arch"
$node = Join-Path $runtime 'node.exe'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $node)) {
  $archive = Join-Path $runtimeRoot $archiveName
  $baseUrl = "https://nodejs.org/dist/v$version"
  $checksums = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing).Content
  $entry = ($checksums -split "`n" | Where-Object { $_ -match ([regex]::Escape($archiveName) + '\s*$') } | Select-Object -First 1)
  if (-not $entry -or $entry -notmatch '^([a-fA-F0-9]{64})\s+') { throw 'Official archive checksum is missing.' }
  $expected = $Matches[1]
  Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archive -UseBasicParsing
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Node archive checksum mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
  Remove-Item -LiteralPath $archive
}
if ((& $node --version).Trim() -ne "v$version") { throw 'Installed runtime does not match the pinned version.' }
$env:Path = $runtime + [IO.Path]::PathSeparator + $env:Path
Push-Location $projectRoot
try {
  & $node (Join-Path $runtime 'node_modules\npm\bin\npm-cli.js') ci --no-audit --engine-strict
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  & $node -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('SELECT 1').get();db.close();console.log('Application runtime '+process.version+'; native SQLite binding verified.');"
  if ($LASTEXITCODE -ne 0) { throw 'Native dependency validation failed.' }
  Write-Output "Ready: npm start uses the pinned LTS runtime when the shell Node is unsupported."
} finally { Pop-Location }
