# BrightBase Start Script

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "`n✨ Starting BrightBase..." -ForegroundColor Cyan

# Start backend
$backendDir = Join-Path $root "backend"
$backendJob = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "cd /d `"$backendDir`" && venv\Scripts\uvicorn.exe main:app --reload --port 8000" `
    -PassThru -NoNewWindow

Write-Host "  Backend starting on http://localhost:8000" -ForegroundColor Green

Start-Sleep -Seconds 2

# Start frontend
$frontendDir = Join-Path $root "frontend"
$frontendJob = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "cd /d `"$frontendDir`" && npm run dev" `
    -PassThru -NoNewWindow

Write-Host "  Frontend starting on http://localhost:5173" -ForegroundColor Green
Write-Host "`n  BrightBase is running! Open: http://localhost:5173" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop`n" -ForegroundColor Gray

# Keep running
try {
    while ($true) { Start-Sleep -Seconds 5 }
} finally {
    Write-Host "Shutting down..." -ForegroundColor Yellow
    Stop-Process -Id $backendJob.Id -ErrorAction SilentlyContinue
    Stop-Process -Id $frontendJob.Id -ErrorAction SilentlyContinue
}
