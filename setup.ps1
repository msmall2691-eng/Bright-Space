# BrightBase Setup Script
# Run once to install all dependencies

param([switch]$SkipPython, [switch]$SkipNode)

Write-Host "`n✨ BrightBase Setup" -ForegroundColor Cyan
Write-Host "===================" -ForegroundColor Cyan

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Backend ---
if (-not $SkipPython) {
    Write-Host "`n[1/3] Setting up Python backend..." -ForegroundColor Yellow

    $backendDir = Join-Path $root "backend"
    Set-Location $backendDir

    # Create .env from example if not exists
    if (-not (Test-Path ".env")) {
        Copy-Item ".env.example" ".env"
        Write-Host "  Created .env — add your API keys to: $backendDir\.env" -ForegroundColor Green
    }

    # Create virtual environment
    if (-not (Test-Path "venv")) {
        Write-Host "  Creating virtual environment..."
        python -m venv venv
    }

    # Install dependencies
    Write-Host "  Installing Python packages..."
    & ".\venv\Scripts\pip.exe" install -r requirements.txt --quiet

    Write-Host "  Backend ready!" -ForegroundColor Green
}

# --- Frontend ---
if (-not $SkipNode) {
    Write-Host "`n[2/3] Setting up React frontend..." -ForegroundColor Yellow

    $frontendDir = Join-Path $root "frontend"
    Set-Location $frontendDir

    Write-Host "  Installing npm packages..."
    npm install --silent

    Write-Host "  Frontend ready!" -ForegroundColor Green
}

Write-Host "`n[3/3] Done!" -ForegroundColor Green
Write-Host @"

Next steps:
  1. Add your API keys to: C:\BrightBase\backend\.env
     - ANTHROPIC_API_KEY
     - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
     - CONNECTEAM_API_KEY / CONNECTEAM_COMPANY_ID

  2. Run BrightBase:
     .\start.ps1

  3. Open: http://localhost:5173

"@ -ForegroundColor White
