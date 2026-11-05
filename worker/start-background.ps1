$ErrorActionPreference = 'Stop'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$supervisor = Join-Path $PSScriptRoot 'supervisor.mjs'
Start-Process -FilePath $nodeExe -ArgumentList ('"' + $supervisor + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
