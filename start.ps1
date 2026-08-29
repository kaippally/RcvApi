$PM2_NAME = "rcv-api"
$SCRIPT   = "server.js"
$CWD      = $PSScriptRoot

$existing = npx --yes pm2 describe $PM2_NAME 2>$null | Select-String "status"

if ($existing) {
    Write-Host "[$PM2_NAME] Restarting existing PM2 process..."
    npx pm2 restart $PM2_NAME
} else {
    Write-Host "[$PM2_NAME] Starting new PM2 process..."
    npx pm2 start $SCRIPT --name $PM2_NAME --cwd $CWD --interpreter node
}

npx pm2 logs $PM2_NAME --lines 20
