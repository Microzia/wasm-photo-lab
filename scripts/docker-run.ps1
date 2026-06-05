$ErrorActionPreference = "Stop"

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerPath = if ($dockerCommand) { $dockerCommand.Source } else { $null }

if (-not $dockerPath) {
  $fallback = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  if (Test-Path $fallback) {
    $dockerPath = $fallback
    $env:Path = "C:\Program Files\Docker\Docker\resources\bin;C:\Program Files\Docker\cli-plugins;$env:Path"
  }
}

if (-not $dockerPath) {
  throw "Docker CLI не установлен или недоступен в PATH."
}

$existing = & $dockerPath ps -aq --filter name=wasm-photo-lab-site
if ($existing) {
  & $dockerPath rm -f wasm-photo-lab-site | Out-Null
}

& $dockerPath run -d --name wasm-photo-lab-site -p 8080:80 wasm-photo-lab
& $dockerPath ps --filter name=wasm-photo-lab-site --format "table {{.Names}}`t{{.Status}}`t{{.Ports}}"
