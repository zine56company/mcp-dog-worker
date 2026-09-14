param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$workerHome = Join-Path $root 'codex-home'
$runRoot = Join-Path $root 'runs'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path $workerHome, $runRoot | Out-Null
$templateRoot = $root.Replace('\', '/')
foreach ($name in @('deepseek-worker', 'glm-worker')) {
    $template = [IO.File]::ReadAllText((Join-Path $root "templates\$name.config.toml"))
    [IO.File]::WriteAllText(
        (Join-Path $workerHome "$name.config.toml"),
        $template.Replace('__MCP_ROOT__', $templateRoot),
        $utf8NoBom
    )
}
Copy-Item -Force -LiteralPath (Join-Path $root 'models\deepseek-v4-flash.json') -Destination (Join-Path $workerHome 'deepseek-model.json')
Copy-Item -Force -LiteralPath (Join-Path $root 'models\glm-5.3-flash.json') -Destination (Join-Path $workerHome 'glm-model.json')
$baseConfig = Join-Path $workerHome 'config.toml'
if (-not (Test-Path -LiteralPath $baseConfig)) {
    [IO.File]::WriteAllText($baseConfig, "# Secret-free isolated Codex home for delegated workers.`n", $utf8NoBom)
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
& $npm --prefix $root ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
foreach ($script in @('router-v2.mjs', 'worker-runner.mjs', 'worker-client.mjs', 'start-windows.mjs')) {
    & $node --check (Join-Path $root $script)
    if ($LASTEXITCODE -ne 0) { throw "node --check failed for $script" }
}
foreach ($catalog in @('deepseek-model.json', 'glm-model.json')) {
    Get-Content -Raw -LiteralPath (Join-Path $workerHome $catalog) | ConvertFrom-Json | Out-Null
}

Write-Output "mcp-dog-worker: Windows setup complete at $root"
Write-Output "mcp-dog-worker: keep credentials outside the repository and pass --env-file to start-windows.mjs"
