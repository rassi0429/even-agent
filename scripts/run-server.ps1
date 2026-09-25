$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$runtime = Get-Content -LiteralPath (Join-Path $workspacePath '.local\server-runtime.json') -Raw | ConvertFrom-Json
Set-Location -LiteralPath $workspacePath
& $runtime.nodePath (Join-Path $workspacePath 'scripts\server-supervisor.mjs')
exit $LASTEXITCODE
