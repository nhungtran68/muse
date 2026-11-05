param([string]$ProfileSource, [switch]$Start)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'MuseBrandWorker'
$appRoot = Join-Path $runtimeRoot 'app'
$installedWorker = Join-Path $appRoot 'worker'
$installedShared = Join-Path $appRoot 'shared'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeMajor = [int]((& $nodeExe --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Can Node.js 22 tro len.' }
New-Item -ItemType Directory -Path $installedWorker,$installedShared -Force | Out-Null
foreach ($lockName in @('worker.lock','supervisor.lock')) {
  $lockFile = Join-Path $runtimeRoot $lockName
  if (Test-Path -LiteralPath $lockFile) {
    $info = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
    if (Get-Process -Id $info.pid -ErrorAction SilentlyContinue) { throw 'Worker dang chay. Khong ghi de tep dang duoc su dung.' }
  }
}
Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Name -notlike '*.test.mjs' -and $_.Extension -in @('.mjs','.js','.py','.json','.ps1','.cmd','.md') } | ForEach-Object {
  $targetFile = Join-Path $installedWorker $_.Name
  if ($_.FullName -ne $targetFile) { Copy-Item -LiteralPath $_.FullName -Destination $targetFile -Force }
}
Get-ChildItem -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared') -File -Filter '*.mjs' | Where-Object Name -NotLike '*.test.mjs' | ForEach-Object {
  $targetFile = Join-Path $installedShared $_.Name
  if ($_.FullName -ne $targetFile) { Copy-Item -LiteralPath $_.FullName -Destination $targetFile -Force }
}
if (!$ProfileSource) { $ProfileSource = Join-Path $PSScriptRoot 'data\muse-profile' }
$profileTarget = Join-Path $runtimeRoot 'muse-profile'
if (!(Test-Path -LiteralPath $profileTarget) -and (Test-Path -LiteralPath $ProfileSource)) {
  Copy-Item -LiteralPath $ProfileSource -Destination $profileTarget -Recurse
}
Push-Location $installedWorker
try {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw 'Khong cai duoc thu vien Worker.' }
  $browserCandidates = @(
    (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
  )
  if (!($browserCandidates | Where-Object { Test-Path -LiteralPath $_ })) {
    & npx.cmd playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Khong cai duoc Chromium cho Worker.' }
  }
} finally { Pop-Location }
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'MuseBrandWorker.cmd'
$launcher = Join-Path $installedWorker 'start-background.ps1'
$startupText = '@echo off' + "`r`n" + 'start "" /b powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"' + "`r`nexit /b 0`r`n"
[IO.File]::WriteAllText($startup,$startupText,[Text.Encoding]::ASCII)
Remove-Item -LiteralPath (Join-Path $runtimeRoot 'stop.request') -ErrorAction SilentlyContinue
Write-Output ('Da cai Worker tai: ' + $installedWorker)
Write-Output 'Worker, Docker va Chrome Muse se tu chay sau khi dang nhap Windows.'
if ($Start) { & $launcher }
