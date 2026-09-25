param([Parameter(Mandatory=$true)][ValidateSet('server','dashboard')][string]$Component)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$status = Get-Content -LiteralPath (Join-Path $workspacePath '.local\supervisor.json') -Raw | ConvertFrom-Json
if ($status.root.TrimEnd('\', '/') -ne $workspacePath.TrimEnd('\', '/')) { throw 'Different workspace' }
$supervisor = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$status.supervisorPid)
if (-not $supervisor -or -not $supervisor.CommandLine.Contains((Join-Path $workspacePath 'scripts\server-supervisor.mjs'))) { throw 'Supervisor is not running' }
$targetId = if ($Component -eq 'server') { $status.serverPid } else { $status.dashboardPid }
if (-not $targetId) { throw 'Component is already restarting' }
$target = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$targetId)
$entry = Join-Path $workspacePath ('apps\' + $Component + '\src\main.ts')
if (-not $target -or -not $target.CommandLine.Contains($entry)) { throw 'PID does not belong to the requested component' }
Stop-Process -Id $targetId -Force
Write-Output ($Component + ' stopped; supervisor will restart it in 3 seconds. A previous display lease can take up to 20 seconds to expire.')
