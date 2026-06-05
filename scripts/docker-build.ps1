$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
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

Push-Location $root
try {
  & $dockerPath build -t wasm-photo-lab .
}
finally {
  Pop-Location
}
