param([ValidateSet('install','build','start','test','typecheck')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($projectRoot.StartsWith('C:\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Project data must not be on C:.' }
$ancestor = Get-Item -LiteralPath $projectRoot
while ($null -ne $ancestor) { if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Directory link is not allowed: $($ancestor.FullName)" }; $ancestor = $ancestor.Parent }
$env:NODE_DISABLE_COMPILE_CACHE='1'
$nodeCandidates = @($env:MIXCAT_NODE, (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'), (Get-Command node -ErrorAction SilentlyContinue).Source) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$nodeExecutable = $nodeCandidates | Where-Object { [int]((& $_ --version).TrimStart('v').Split('.')[0]) -ge 24 } | Select-Object -First 1
if (-not $nodeExecutable) { throw 'Node.js 24+ is required; set MIXCAT_NODE to its executable.' }
$codexExecutable = (Get-Command codex -ErrorAction SilentlyContinue).Source
if (-not $env:MIXCAT_CODEX -and $codexExecutable) { $env:MIXCAT_CODEX = $codexExecutable }
$env:PATH = (Split-Path -Parent $nodeExecutable) + ';' + $env:PATH
foreach ($name in @('tmp','npm-cache','electron-cache','cache','logs')) {
  $directory=Join-Path $projectRoot ".runtime\client\$name"
  $candidate = $directory
  while ($candidate) { if (Test-Path -LiteralPath $candidate) { if (((Get-Item -LiteralPath $candidate).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Runtime directory link is not allowed: $candidate" } }; $parent=[IO.Path]::GetDirectoryName($candidate); if ($parent -eq $candidate) { break }; $candidate=$parent }
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$env:TSX_DISABLE_CACHE='1'
$env:TEMP=Join-Path $projectRoot '.runtime\client\tmp'; $env:TMP=$env:TEMP
$env:npm_config_cache=Join-Path $projectRoot '.runtime\client\npm-cache'
$env:ELECTRON_CACHE=Join-Path $projectRoot '.runtime\client\electron-cache'
$env:electron_config_cache=$env:ELECTRON_CACHE
$env:XDG_CACHE_HOME=Join-Path $projectRoot '.runtime\client\cache'
if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) { $env:NODE_USE_ENV_PROXY='1' }
Set-Location -LiteralPath $projectRoot
if ($Action -eq 'install') {
  $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
  $npmCli = Join-Path (Split-Path -Parent $npmCommand) 'node_modules\npm\bin\npm-cli.js'
  if (-not (Test-Path -LiteralPath $npmCli)) { throw 'Cannot locate npm-cli.js; install npm beside a supported Node runtime.' }
  & $nodeExecutable $npmCli install --no-audit --no-fund
  if ($LASTEXITCODE -eq 0) { & $nodeExecutable 'node_modules/electron/install.js' }
} elseif ($Action -eq 'test') { & $nodeExecutable --import tsx --test 'tests/*.test.ts' }
elseif ($Action -eq 'typecheck') { & $nodeExecutable 'node_modules/typescript/bin/tsc' --noEmit }
elseif ($Action -eq 'build') { & $nodeExecutable 'scripts/build.mjs' }
else { & $nodeExecutable 'scripts/build.mjs'; if ($LASTEXITCODE -eq 0) { & $nodeExecutable 'scripts/start.mjs' } }
exit $LASTEXITCODE
