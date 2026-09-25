$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$localPath = Join-Path $workspacePath '.local'
New-Item -ItemType Directory -Path $localPath -Force | Out-Null
$nodePath = (& node -p 'process.execPath').Trim()
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node executable not found' }
@{ nodePath = $nodePath } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $localPath 'server-runtime.json') -Encoding UTF8
$taskName = 'Even Agent Server'
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$scriptPath = Join-Path $workspacePath 'scripts\run-server.ps1'
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $taskArguments -WorkingDirectory $workspacePath
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions.Arguments -notcontains $taskArguments)) { throw 'An unrelated task with this name already exists; no changes made.' }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Even Agent dashboard server; restarts after failure and starts when this user signs in.' -Force | Out-Null
Write-Output 'Registered Even Agent Server at user logon. Start with: Start-ScheduledTask -TaskName "Even Agent Server"'
