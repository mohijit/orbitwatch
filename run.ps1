#Requires -Version 5.1
<#
.SYNOPSIS
    Runs OrbitWatch locally: the Fastify API and the Next.js web app together.

.DESCRIPTION
    Starts both services, waits until each is genuinely answering, and opens the app.
    Ctrl+C shuts both down cleanly.

    Two things this handles that catch people out on Windows:

      * CORS. The API only sends CORS headers when CORS_ORIGINS is set. Without it the
        globe loads but every catalog request is blocked by the browser, leaving an
        empty sphere and "Failed to load catalog". This sets it to match the port the
        web app is actually served on.

      * Orphans. A killed pnpm run routinely leaves node.exe children holding a port,
        and the next start then fails or quietly attaches to stale code. This clears
        whatever is listening on both ports first, and kills whole process TREES on
        exit rather than just the pnpm wrapper.

.PARAMETER Port
    Port for the web app. Defaults to 3000, or 3100 with -Prod.

.PARAMETER ApiPort
    Port for the API. Default 3333.

.PARAMETER Prod
    Build and serve the production bundle instead of running the dev server. Slower to
    start, but it is what the E2E suite and a deployment actually exercise.

.PARAMETER NoBrowser
    Do not open a browser window.

.EXAMPLE
    .\run.ps1

.EXAMPLE
    .\run.ps1 -Prod -NoBrowser
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [int]$ApiPort = 3333,
    [switch]$Prod,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location -Path $root

if ($Port -eq 0) {
    if ($Prod) { $Port = 3100 } else { $Port = 3000 }
}

$script:Children = @()

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "    $Text" -ForegroundColor Yellow }

function Stop-Tree {
    # taskkill /T is the only reliable way to take down pnpm's node.exe descendants.
    param([int]$TargetId)
    if ($TargetId -le 0) { return }
    Start-Process -FilePath "taskkill.exe" `
        -ArgumentList "/F", "/T", "/PID", "$TargetId" `
        -NoNewWindow -Wait -ErrorAction SilentlyContinue | Out-Null
}

function Clear-Port {
    param([int]$Number, [string]$Label)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Number -State Listen -ErrorAction Stop
    } catch {
        return
    }
    $owners = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($owner in $owners) {
        Write-Warn "port $Number ($Label) held by PID $owner - clearing it"
        Stop-Tree -TargetId $owner
    }
    Start-Sleep -Milliseconds 500
}

function Wait-ForUrl {
    param([string]$Url, [int]$TimeoutSeconds, [string]$Label)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        foreach ($child in $script:Children) {
            if ($child.HasExited) {
                throw "$Label exited (code $($child.ExitCode)) before it started serving. Its output is above."
            }
        }
        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null
            return
        } catch {
            Start-Sleep -Milliseconds 700
        }
    }
    throw "$Label did not respond at $Url within $TimeoutSeconds seconds."
}

function Start-Child {
    param([string[]]$Arguments)
    # Depending on how pnpm was installed (corepack, npm -g, scoop) it resolves to a
    # .ps1 or .cmd shim, and Start-Process can execute neither directly - it fails with
    # "%1 is not a valid Win32 application". Going through cmd.exe lets PATHEXT resolve
    # whichever shim exists, and taskkill /T on the cmd.exe tree still reaps the node
    # children underneath it.
    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList (@("/c", "pnpm") + $Arguments) `
        -NoNewWindow -PassThru
    $script:Children += $proc
}

try {
    # ---- preflight -----------------------------------------------------------------
    Write-Step "Checking prerequisites"

    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) {
        throw "pnpm is not on PATH. Run: corepack enable pnpm"
    }
    Write-Ok "pnpm $(& pnpm --version)"

    if (-not (Test-Path (Join-Path $root "node_modules"))) {
        Write-Warn "node_modules missing - running pnpm install"
        & pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }
    }

    if (-not (Test-Path (Join-Path $root ".env.local"))) {
        throw ".env.local not found. Copy .env.example to .env.local, then fill in DATABASE_URL and the Upstash credentials."
    }
    Write-Ok ".env.local present"

    # The web app imports built output from these packages, not their source.
    $needsLibs = $false
    foreach ($lib in @("packages\orbit-core\dist", "packages\contracts\dist")) {
        if (-not (Test-Path (Join-Path $root $lib))) { $needsLibs = $true }
    }
    if ($needsLibs) {
        Write-Step "Building workspace libraries"
        & pnpm turbo run build --filter=@orbitwatch/orbit-core --filter=@orbitwatch/contracts
        if ($LASTEXITCODE -ne 0) { throw "Workspace library build failed." }
    }

    Clear-Port -Number $ApiPort -Label "api"
    Clear-Port -Number $Port -Label "web"

    # ---- environment ---------------------------------------------------------------
    # The API reads .env.local itself, and real process env wins over that file, so
    # setting these here overrides it without editing anything on disk.
    $webOrigin = "http://localhost:$Port"
    $env:PORT = "$ApiPort"
    $env:CORS_ORIGINS = "$webOrigin,http://127.0.0.1:$Port"
    $env:NEXT_PUBLIC_API_BASE_URL = "http://localhost:$ApiPort"

    # ---- api -----------------------------------------------------------------------
    Write-Step "Starting API on port $ApiPort"
    Start-Child -Arguments @("--filter", "@orbitwatch/api", "dev")
    Wait-ForUrl -Url "http://127.0.0.1:$ApiPort/health/live" -TimeoutSeconds 90 -Label "API"
    Write-Ok "API is live"

    # /health reports dependencies by name, health and latency only - never credentials.
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 10
        if ($health.dependencies.database.healthy) {
            Write-Ok "database healthy ($($health.dependencies.database.latencyMs) ms)"
        } else {
            Write-Warn "DATABASE UNHEALTHY - the globe will load but stay empty."
        }
        if ($health.dependencies.cache.healthy) {
            Write-Ok "cache healthy ($($health.dependencies.cache.latencyMs) ms)"
        } else {
            Write-Warn "cache unhealthy - the app still works, just slower."
        }
    } catch {
        Write-Warn "Could not read /health: $($_.Exception.Message)"
    }

    # ---- web -----------------------------------------------------------------------
    if ($Prod) {
        Write-Step "Building the web app (production)"
        # NEXT_PUBLIC_* values are inlined at build time, so the API URL must already
        # be set in the environment before this runs.
        & pnpm --filter @orbitwatch/web build
        if ($LASTEXITCODE -ne 0) { throw "Web build failed." }

        Write-Step "Serving the production build on port $Port"
        Start-Child -Arguments @("--filter", "@orbitwatch/web", "exec", "next", "start", "--port", "$Port")
    } else {
        Write-Step "Starting the web dev server on port $Port"
        Start-Child -Arguments @("--filter", "@orbitwatch/web", "exec", "next", "dev", "--port", "$Port")
    }

    Wait-ForUrl -Url $webOrigin -TimeoutSeconds 240 -Label "Web app"

    Write-Host ""
    Write-Host "  OrbitWatch is running" -ForegroundColor Green
    Write-Host "    app : $webOrigin"
    Write-Host "    api : http://localhost:$ApiPort"
    Write-Host ""
    Write-Host "  The catalog is around 10 MB, so the first paint takes a few seconds." -ForegroundColor DarkGray
    Write-Host "  Press Ctrl+C to stop both." -ForegroundColor DarkGray
    Write-Host ""

    if (-not $NoBrowser) { Start-Process $webOrigin | Out-Null }

    # ---- wait ----------------------------------------------------------------------
    # TreatControlCAsInput stops Ctrl+C from killing this script outright, so the
    # finally block below is guaranteed to run and reap the child process trees.
    # It needs a real console: with stdout redirected (CI, a pipe) the handle is
    # invalid, so fall back to letting Ctrl+C terminate normally.
    $script:InteractiveConsole = $true
    try {
        [Console]::TreatControlCAsInput = $true
    } catch {
        $script:InteractiveConsole = $false
        Write-Warn "No interactive console - Ctrl+C will stop this script directly."
    }

    while ($true) {
        if ($script:InteractiveConsole -and [Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            if (($key.Modifiers -band [ConsoleModifiers]::Control) -and ($key.Key -eq "C")) {
                Write-Host ""
                Write-Step "Shutting down"
                break
            }
        }
        $dead = $script:Children | Where-Object { $_.HasExited }
        if ($null -ne $dead) {
            Write-Host ""
            Write-Warn "A service exited on its own - stopping the other one."
            break
        }
        Start-Sleep -Milliseconds 250
    }
} catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($script:InteractiveConsole) {
        try { [Console]::TreatControlCAsInput = $false } catch { }
    }
    foreach ($child in $script:Children) {
        if (-not $child.HasExited) { Stop-Tree -TargetId $child.Id }
    }
    Write-Host "Stopped." -ForegroundColor DarkGray
}
