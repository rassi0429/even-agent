$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$statusPath = Join-Path $workspacePath '.local\supervisor.json'
if (-not (Test-Path -LiteralPath $statusPath)) { throw 'No supervisor status file found' }
$status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
if ($status.root.TrimEnd('\', '/') -ne $workspacePath.TrimEnd('\', '/')) { throw 'Supervisor belongs to a different workspace' }
# Validate command lines before stopping recorded PIDs, which may have been reused.
foreach ($target in @(@{ id=$status.supervisorPid; file=(Join-Path $workspacePath 'scripts\server-supervisor.mjs') }, @{ id=$status.serverPid; file=(Join-Path $workspacePath 'apps\server\src\main.ts') }, @{ id=$status.dashboardPid; file=(Join-Path $workspacePath 'apps\dashboard\src\main.ts') })) {
  if (-not $target.id) { continue }
  $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$target.id)
  if (-not $processInfo) { continue }
  if (-not $processInfo.CommandLine.Contains($target.file)) { throw 'Recorded PID no longer belongs to Even Agent; refusing to stop it' }
  Stop-Process -Id $target.id -Force
}
$task = Get-ScheduledTask -TaskName 'Even Agent Server' -ErrorAction SilentlyContinue
if ($task -and ($task.Actions.Arguments -like ('*' + (Join-Path $workspacePath 'scripts\run-server.ps1') + '*'))) {
  Stop-ScheduledTask -TaskName 'Even Agent Server'
}
Write-Output 'Stopped. The logon task remains installed; use Disable-ScheduledTask to disable automatic startup.'
