param(
  [ValidateSet('setup', 'start', 'restart', 'stop', 'status')]
  [string]$Action = 'setup',
  [string]$PythonPath = ''
)

$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
$ReleaseTag = 'v2.0.0a4'
$Namespace = 'qq-bridge'
$HttpPort = 8080
$GrpcPort = 50051
$WheelName = 'a_memorix-2.0.0a4-py3-none-any.whl'
$WheelSha256 = 'a1eed56f064321d6a68404c31ac175de704e0772f8ad612d3b62b5975573c25d'
$GatewayName = 'a-memorix-gateway-windows-amd64.exe'
$GatewaySha256 = '3031717be0d80b571174d009f37cd73a1108af49252c63f35df0e2b0883dfa65'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$StateRoot = Join-Path $RepoRoot 'state\a-memorix'
$BinRoot = Join-Path $StateRoot 'bin'
$SecretRoot = Join-Path $StateRoot 'secrets'
$DataRoot = Join-Path $StateRoot 'data'
$LogRoot = Join-Path $StateRoot 'logs'
$ConfigPath = Join-Path $StateRoot 'config.toml'
$AdminTokenPath = Join-Path $SecretRoot 'admin-token'
$GatewayPath = Join-Path $BinRoot 'a-memorix-gateway.exe'
$WheelPath = Join-Path $BinRoot $WheelName
$PythonVenv = Join-Path $StateRoot 'venv'
$PythonVenvExe = Join-Path $PythonVenv 'Scripts\python.exe'
$CliPath = Join-Path $PythonVenv 'Scripts\a-memorix.exe'
$ServerPidPath = Join-Path $StateRoot 'server.pid.json'
$GatewayPidPath = Join-Path $StateRoot 'gateway.pid.json'
$BridgeConfigPath = Join-Path $RepoRoot 'config.json'

function Ensure-Directories {
  foreach ($path in @($StateRoot, $BinRoot, $SecretRoot, $DataRoot, $LogRoot)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
}

function Ensure-ReleaseFile([string]$path, [string]$asset, [string]$expectedHash) {
  $actualHash = ''
  if (Test-Path -LiteralPath $path) {
    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if ($actualHash -ne $expectedHash) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    $url = "https://github.com/A-Dawn/A_memorix/releases/download/$ReleaseTag/$asset"
    Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "A_Memorix $asset 的 SHA-256 校验失败" }
  }
}

function Find-Python {
  $candidates = @()
  if ($PythonPath) { $candidates += $PythonPath }
  $onPath = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $codexPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
  if (Test-Path -LiteralPath $codexPython) { $candidates += $codexPython }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $versionText = (& $candidate --version 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^Python\s+(\d+\.\d+\.\d+)') { continue }
    if ([version]$Matches[1] -ge [version]'3.12.0') { return $candidate }
  }
  throw '需要 Python 3.12 或更高版本。可用 -PythonPath 指定 python.exe。'
}

function Ensure-PythonEnvironment {
  if (-not (Test-Path -LiteralPath $PythonVenvExe)) {
    $python = Find-Python
    & $python -m venv $PythonVenv
    if ($LASTEXITCODE -ne 0) { throw '创建 A_Memorix Python 环境失败' }
  }
  & $PythonVenvExe -m pip install --disable-pip-version-check "${WheelPath}[rpc,observability,vector]"
  if ($LASTEXITCODE -ne 0) { throw '安装 A_Memorix Python 运行依赖失败' }
  if (-not (Test-Path -LiteralPath $CliPath)) { throw 'A_Memorix CLI 安装后仍不存在' }
  & $PythonVenvExe -c 'import faiss' 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'A_Memorix Faiss 向量依赖未能导入' }
}

function Ensure-ServiceConfig {
  if (-not (Test-Path -LiteralPath $AdminTokenPath)) {
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [System.IO.File]::WriteAllText($AdminTokenPath, $token, [System.Text.UTF8Encoding]::new($false))
  }
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    $toml = @'
[server]
data_dir = "./data"
host = "127.0.0.1"
port = 50051
allow_unauthenticated = false
admin_token_file = "./secrets/admin-token"

[client]
target = "127.0.0.1:50051"
token_file = "./secrets/admin-token"

[observability]
log_level = "INFO"
log_format = "json"
access_log = true
'@
    [System.IO.File]::WriteAllText($ConfigPath, $toml, [System.Text.UTF8Encoding]::new($false))
  }
}

function Test-TcpPort([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(800)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Get-OwnedProcess([string]$pidPath, [string]$expectedExe) {
  if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
  try { $record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json } catch { return $null }
  $process = Get-Process -Id ([int]$record.processId) -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $actualExe = ''
  try { $actualExe = $process.Path } catch {}
  if (-not $actualExe -or -not [string]::Equals($actualExe, $expectedExe, [StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  return $process
}

function Start-ManagedProcess([string]$name, [string]$exe, [string[]]$arguments, [int]$port, [string]$pidPath) {
  if (Get-OwnedProcess $pidPath $exe) { return }
  if (Test-TcpPort $port) { throw "端口 $port 已被其他进程占用；未尝试终止该进程" }
  $stdout = Join-Path $LogRoot "$name.log"
  $stderr = Join-Path $LogRoot "$name.error.log"
  $process = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $StateRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $record = @{ processId = $process.Id; executable = $exe } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($pidPath, $record, [System.Text.UTF8Encoding]::new($false))
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-TcpPort $port) { return }
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
  }
  throw "$name 未能监听端口 $port；日志位于 state/a-memorix/logs/"
}

function Start-Services {
  if (-not (Test-Path -LiteralPath $ConfigPath) -or -not (Test-Path -LiteralPath $CliPath) -or -not (Test-Path -LiteralPath $GatewayPath)) {
    throw 'A_Memorix 尚未安装；请先运行 setup。'
  }
  Start-ManagedProcess 'server' $CliPath @('--config', $ConfigPath, 'serve') $GrpcPort $ServerPidPath
  Start-ManagedProcess 'gateway' $GatewayPath @('-listen', "127.0.0.1:$HttpPort", '-grpc-target', "127.0.0.1:$GrpcPort") $HttpPort $GatewayPidPath
  $health = Invoke-WebRequest -Uri "http://127.0.0.1:$HttpPort/healthz" -UseBasicParsing -TimeoutSec 5
  if ($health.StatusCode -ne 200) { throw 'A_Memorix Gateway 健康检查失败' }
}

function Stop-ManagedProcess([string]$pidPath, [string]$expectedExe) {
  $process = Get-OwnedProcess $pidPath $expectedExe
  if ($process) { Stop-Process -Id $process.Id -Force }
  if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
}

function Configure-Bridge([string]$apiKey) {
  if (-not (Test-Path -LiteralPath $BridgeConfigPath)) { throw '仓库根目录缺少 config.json' }
  $config = Get-Content -LiteralPath $BridgeConfigPath -Raw | ConvertFrom-Json
  $memory = @{}
  if ($config.memory) {
    foreach ($property in $config.memory.PSObject.Properties) { $memory[$property.Name] = $property.Value }
  }
  $memory['enabled'] = $true
  $memory['baseUrl'] = "http://127.0.0.1:$HttpPort"
  $memory['namespace'] = $Namespace
  $memory['apiKey'] = $apiKey
  if (-not $memory.ContainsKey('timeoutMs')) { $memory['timeoutMs'] = 45000 }
  if (-not $memory.ContainsKey('bootstrapLimit')) { $memory['bootstrapLimit'] = 6 }
  if (-not $memory.ContainsKey('bootstrapMaxChars')) { $memory['bootstrapMaxChars'] = 2500 }
  $config | Add-Member -MemberType NoteProperty -Name memory -Value ([pscustomobject]$memory) -Force
  $json = $config | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($BridgeConfigPath, "$json`r`n", [System.Text.UTF8Encoding]::new($false))
}

function Invoke-Setup {
  Ensure-Directories
  Ensure-ReleaseFile $WheelPath $WheelName $WheelSha256
  Ensure-ReleaseFile $GatewayPath $GatewayName $GatewaySha256
  Ensure-PythonEnvironment
  Ensure-ServiceConfig
  Start-Services

  $namespaceInfo = & $CliPath --config $ConfigPath namespace get $Namespace 2>$null | Out-String
  if ($LASTEXITCODE -ne 0) {
    & $CliPath --config $ConfigPath namespace create $Namespace --allow-metadata-only-write --sparse-retrieval | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '创建 qq-bridge namespace 失败' }
  }

  $existing = Get-Content -LiteralPath $BridgeConfigPath -Raw | ConvertFrom-Json
  $existingKey = [string]$existing.memory.apiKey
  $existingNamespace = [string]$existing.memory.namespace
  $existingBaseUrl = [string]$existing.memory.baseUrl
  if ($existingKey -and $existingNamespace -eq $Namespace -and $existingBaseUrl -eq "http://127.0.0.1:$HttpPort") {
    $apiKey = $existingKey
  } else {
    $keyJson = & $CliPath --config $ConfigPath api-key create $Namespace --label 'qq-bridge' 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { throw '创建 qq-bridge namespace API key 失败' }
    $apiKey = [string](($keyJson | ConvertFrom-Json).secret)
    if (-not $apiKey) { throw 'A_Memorix 未返回 namespace API key；密钥没有写入 config.json' }
  }
  Configure-Bridge $apiKey
  Write-Output "A_Memorix $ReleaseTag 已启动，namespace=$Namespace，Gateway=http://127.0.0.1:$HttpPort。config.json 已启用长期记忆；请重启 qq-bridge。"
}

switch ($Action) {
  'setup' { Invoke-Setup }
  'start' { Start-Services; Write-Output 'A_Memorix 服务已启动。' }
  'restart' {
    Stop-ManagedProcess $GatewayPidPath $GatewayPath
    Stop-ManagedProcess $ServerPidPath $CliPath
    Start-Services
    Write-Output 'A_Memorix 服务已重启。'
  }
  'stop' {
    Stop-ManagedProcess $GatewayPidPath $GatewayPath
    Stop-ManagedProcess $ServerPidPath $CliPath
    Write-Output 'A_Memorix 服务已停止。'
  }
  'status' {
    $httpOk = $false
    try { $httpOk = (Invoke-WebRequest -Uri "http://127.0.0.1:$HttpPort/healthz" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch {}
    [pscustomobject]@{
      release = $ReleaseTag
      namespace = $Namespace
      gateway = if ($httpOk) { 'healthy' } else { 'offline' }
      grpcPortListening = Test-TcpPort $GrpcPort
      dataDirectory = $DataRoot
    } | Format-List
  }
}
