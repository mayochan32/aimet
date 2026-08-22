$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
  throw 'This live test must run on native Windows.'
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo

function Find-CodeCommand {
  foreach ($name in @('code.cmd', 'code', 'code-insiders.cmd', 'code-insiders', 'codium.cmd', 'codium')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
    (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd'),
    (Join-Path $env:ProgramFiles 'Microsoft VS Code Insiders\bin\code-insiders.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\VSCodium\bin\codium.cmd'),
    (Join-Path $env:ProgramFiles 'VSCodium\bin\codium.cmd')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw 'VS Code CLI (code/code-insiders/codium) was not found.'
}

function Find-CopilotRoots {
  $roots = @()
  if ($env:AIMET_COPILOT_DIR) {
    foreach ($candidate in $env:AIMET_COPILOT_DIR.Split(';')) {
      if ($candidate.Trim() -and (Test-Path $candidate.Trim())) {
        $roots += (Resolve-Path $candidate.Trim()).Path
      }
    }
  }
  foreach ($product in @('Code', 'Code - Insiders', 'VSCodium')) {
    $userDir = Join-Path $env:APPDATA "$product\User"
    foreach ($candidate in @(
      (Join-Path $userDir 'workspaceStorage'),
      (Join-Path $userDir 'globalStorage\github.copilot-chat')
    )) {
      if (Test-Path $candidate) { $roots += (Resolve-Path $candidate).Path }
    }
  }
  $roots = @($roots | Select-Object -Unique)
  if ($roots.Count -eq 0) {
    throw 'VS Code Copilot log roots were not found under APPDATA. Set AIMET_COPILOT_DIR for non-standard locations.'
  }
  return $roots
}

function Get-RelevantLogs([string[]]$roots) {
  $seen = @{}
  $files = @()
  foreach ($root in $roots) {
    if (!(Test-Path $root)) { continue }
    foreach ($file in Get-ChildItem $root -Recurse -File -Filter '*.jsonl') {
      $inDebugLogs = $file.FullName -match '[\\/]GitHub\.copilot-chat[\\/]debug-logs[\\/]'
      $uiOnly = $file.Name -match '^(title|categorization|summarize)-'
      $relevant = $file.FullName -match '[\\/]chatSessions[\\/]' -or ($inDebugLogs -and !$uiOnly)
      if ($relevant -and !$seen.ContainsKey($file.FullName)) {
        $seen[$file.FullName] = $true
        $files += $file
      }
    }
  }
  return $files
}

function Get-Snapshot([string[]]$roots) {
  $snapshot = @{}
  foreach ($file in Get-RelevantLogs $roots) {
    $snapshot[$file.FullName] = "$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
  }
  return $snapshot
}

function Get-ChangedLogs([string[]]$roots, [hashtable]$before) {
  return @(Get-RelevantLogs $roots | Where-Object {
    !$before.ContainsKey($_.FullName) -or $before[$_.FullName] -ne "$($_.Length):$($_.LastWriteTimeUtc.Ticks)"
  })
}

function Wait-ForLogs([string[]]$roots, [hashtable]$before, [int]$minimumChildren, [int]$timeoutSeconds = 600) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  $lastSignature = ''
  $stableSince = $null
  while ((Get-Date) -lt $deadline) {
    $changed = Get-ChangedLogs $roots $before
    $children = @($changed | Where-Object {
      $_.FullName -match '[\\/]GitHub\.copilot-chat[\\/]debug-logs[\\/]' -and
      $_.Name -ne 'main.jsonl'
    })
    $hasParent = @($changed | Where-Object { $_.Name -eq 'main.jsonl' -or $_.FullName -match '[\\/]chatSessions[\\/]' }).Count -gt 0
    $signature = ($changed | Sort-Object FullName | ForEach-Object { "$($_.FullName):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }) -join '|'
    if ($hasParent -and $children.Count -ge $minimumChildren) {
      if ($signature -eq $lastSignature) {
        if ($null -eq $stableSince) { $stableSince = Get-Date }
        if (((Get-Date) - $stableSince).TotalSeconds -ge 20) { return $changed }
      } else {
        $lastSignature = $signature
        $stableSince = Get-Date
      }
    }
    Start-Sleep -Seconds 2
  }
  throw "Timed out waiting for Copilot logs (required children: $minimumChildren)."
}

function Copy-CapturedLogs([object[]]$files, [string]$destination) {
  foreach ($file in $files) {
    if ($file.FullName -match '[\\/]chatSessions[\\/]') {
      $targetDir = Join-Path $destination 'workspace\chatSessions'
    } elseif ($file.FullName -match '[\\/]debug-logs[\\/]([^\\/]+)[\\/]') {
      $targetDir = Join-Path $destination "workspace\GitHub.copilot-chat\debug-logs\$($Matches[1])"
    } else {
      continue
    }
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Copy-Item -Force $file.FullName (Join-Path $targetDir $file.Name)
  }
}

$code = Find-CodeCommand
$copilotRoots = @(Find-CopilotRoots)

& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw "npm test failed with exit code $LASTEXITCODE" }

$runRoot = Join-Path ([IO.Path]::GetTempPath()) ("aimet Windows E2E 日本語 " + [guid]::NewGuid())
$workspace = Join-Path $runRoot 'workspace input'
$captured = Join-Path $runRoot 'captured logs'
$db = Join-Path $runRoot 'aimet db\metrics.db'
$result = Join-Path $runRoot 'windows-copilot-e2e.json'
New-Item -ItemType Directory -Force -Path $workspace, $captured | Out-Null
Set-Content -Encoding UTF8 (Join-Path $workspace 'single input.txt') @('alpha', 'beta', 'gamma')
Set-Content -Encoding UTF8 (Join-Path $workspace 'child A.txt') @('red', 'green', 'blue')
Set-Content -Encoding UTF8 (Join-Path $workspace 'child B.txt') @('one two', 'three four', 'five six')

$beforeSingle = Get-Snapshot $copilotRoots
Set-Location $workspace
& $code chat -m agent -n -a (Join-Path $workspace 'single input.txt') `
  'Read the attached file and report its first and last line. Do not delegate, edit files, or run terminal commands.'
if ($LASTEXITCODE -ne 0) { throw "VS Code single-agent launch failed with exit code $LASTEXITCODE" }
$singleLogs = Wait-ForLogs $copilotRoots $beforeSingle 0

$beforeMulti = Get-Snapshot $copilotRoots
& $code chat -m agent -n -a (Join-Path $workspace 'child A.txt') -a (Join-Path $workspace 'child B.txt') `
  'Use exactly two subagents in parallel. One must inspect child A.txt and the other child B.txt. The parent must only combine their results. Do not edit files or run terminal commands.'
if ($LASTEXITCODE -ne 0) { throw "VS Code multi-agent launch failed with exit code $LASTEXITCODE" }
$multiLogs = Wait-ForLogs $copilotRoots $beforeMulti 2

Copy-CapturedLogs (@($singleLogs) + @($multiLogs)) $captured
Set-Location $repo
$env:AIMET_DB = $db
$first = & node dist/cli.js collect --tool copilot --dir $captured
if ($LASTEXITCODE -ne 0) { throw "aimet collect failed with exit code $LASTEXITCODE" }
Write-Host $first
& node test/e2e/verify-copilot-logs.mjs $db $captured $result
if ($LASTEXITCODE -ne 0) { throw "independent verifier failed with exit code $LASTEXITCODE" }
$second = & node dist/cli.js collect --tool copilot --dir $captured
if ($LASTEXITCODE -ne 0) { throw "second aimet collect failed with exit code $LASTEXITCODE" }
Write-Host $second
if ($second -notmatch '\+0 new, ~0 updated') {
  throw "Second collect was not idempotent: $second"
}

Write-Host "Windows Copilot E2E passed. Result: $result"
