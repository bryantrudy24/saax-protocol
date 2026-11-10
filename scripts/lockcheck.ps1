# lockcheck.ps1 - emit lockfile pinning for top-level deps (security sprint Item 1)
$ErrorActionPreference = 'Stop'
$lines = Get-Content package-lock.json
$inTop = $false
$i = 0
$results = @()
while ($i -lt $lines.Count) {
  $line = $lines[$i]
  if ($line -match 'node_modules/(dotenv|ethers|viem)"') {
    $pkg = $Matches[1]
    # look ahead for "version" within next 4 lines
    $j = $i + 1
    $found = ''
    while ($j -lt [Math]::Min($i + 5, $lines.Count)) {
      if ($lines[$j] -match '"version":\s*"([^"]+)"') { $found = $Matches[1]; break }
      $j++
    }
    $results += ("{0} locked={1}" -f $pkg, $found)
  }
  $i++
}
$results
"--- package.json deps ---"
$pj = Get-Content package.json -Raw | ConvertFrom-Json
foreach ($p in $pj.dependencies.PSObject.Properties) { "{0}={1}" -f $p.Name, $p.Value }