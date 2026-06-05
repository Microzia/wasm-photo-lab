$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$index = Join-Path $root "web\dist\index.html"

Push-Location $root
try {
  Write-Host "Сборка WASM-пакета..."
  npm run build:wasm

  Write-Host "Сборка web-версии для запуска из файла..."
  npm run build:web:file

  Write-Host ""
  Write-Host "Открываю $index"
  Write-Host "Если браузер заблокирует Web Worker или WASM из file://, используйте npm run dev или Docker."
  Start-Process $index
}
finally {
  Pop-Location
}
