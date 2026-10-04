$ErrorActionPreference = 'Stop'
$photoGameRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $photoGameRoot
if (-not (Test-Path -LiteralPath '.env')) {
    throw 'Copy .env.example to .env and configure the server first. Defaults keep payments disabled.'
}
& node --env-file=.env backend/server.mjs
exit $LASTEXITCODE
