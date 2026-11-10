# audit-pinning.ps1 - report dependency pinning + installed versions (security sprint Item 1)
$ErrorActionPreference = 'Stop'
$pj = Get-Content package.json -Raw | ConvertFrom-Json
"=== package.json dependencies ==="
foreach ($p in $pj.dependencies.PSObject.Properties) { "{0}={1}" -f $p.Name, $p.Value }
"=== installed versions (node_modules) ==="
foreach ($d in @('dotenv','ethers','viem')) {
  $p = Join-Path 'node_modules' (($d -replace '/', [IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar + 'package.json')
  if (Test-Path $p) {
    $pkg = Get-Content $p -Raw | ConvertFrom-Json
    "{0} installed={1}" -f $d, $pkg.version
  } else { "{0} NOT-INSTALLED" -f $d }
}
"=== lockfile pinning (top-level deps in package-lock.json) ==="
$lock = Get-Content package-lock.json -Raw | ConvertFrom-Json
"lockfileVersion={0}" -f $lock.lockfileVersion
foreach ($p in $lock.packages.PSObject.Properties) {
  if ($p.Name -match '^node_modules/(dotenv|ethers|viem)$') {
    "{0} locked={1}" -f $p.Name, $p.Value.version
  }
}