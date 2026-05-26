Push-Location $PSScriptRoot
if (Test-Path node_modules\.vite) {
    Remove-Item -Recurse -Force node_modules\.vite
    Write-Host "Vite cache cleared"
}
Write-Host "Starting dev server from: $PWD"
npm run dev
Pop-Location
