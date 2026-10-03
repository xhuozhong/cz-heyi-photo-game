$ErrorActionPreference = 'Stop'
$gameFolder = $PSScriptRoot
$gamePort = if ($env:PUBLIC_PORT) { $env:PUBLIC_PORT } else { '4175' }
$gameUrl = "http://127.0.0.1:$gamePort"
$taskNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $taskNode) {
    $taskNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $taskNode)) { throw 'Node.js is required to start the game.' }
$alreadyRunning = $false
try {
    $page = Invoke-WebRequest -Uri $gameUrl -TimeoutSec 2
    $alreadyRunning = $page.Content.Contains('id="genderSelect"')
} catch { }
if (-not $alreadyRunning) {
    $serverFile = Join-Path $gameFolder 'static-server.mjs'
    Start-Process -FilePath $taskNode -ArgumentList @('"' + $serverFile + '"') -WorkingDirectory $gameFolder -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $page = Invoke-WebRequest -Uri $gameUrl -TimeoutSec 2
            if ($page.Content.Contains('id="genderSelect"')) { $alreadyRunning = $true; break }
        } catch { }
    }
}
if (-not $alreadyRunning) { throw 'The game could not start. Check README.md for troubleshooting.' }
Start-Process $gameUrl
