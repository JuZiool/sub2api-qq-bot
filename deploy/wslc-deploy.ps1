#requires -Version 7.3
[CmdletBinding()]
param(
    [ValidateSet('Up','Status','Stop','Logs')][string]$Action = 'Up',
    [switch]$Build,
    [switch]$PullNapcat,
    [string]$EnvFile,
    [string]$Sub2ApiUrl,
    [string]$ApiNetwork,
    [string]$NapcatImage = 'mlikiowa/napcat-docker:latest',
    [ValidateSet('bot','napcat')][string]$Service = 'bot',
    [ValidateRange(1,1000)][int]$Tail = 80,
    [ValidateRange(15,900)][int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wslc-common.ps1')
if (-not $IsWindows) { throw '需要 Windows PowerShell 7.3+ 与 WSLC。' }
Get-Command wslc -ErrorAction Stop | Out-Null
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$state = Join-Path $PSScriptRoot '.wslc'
$names = @{ bot='qq-bot-wslc-bot'; napcat='qq-bot-wslc-napcat' }
$network = 'qq-bot-wslc-network'
$mutex = [Threading.Mutex]::new($false,'Local\Sub2ApiQqBotWslcDeploy')
$locked = $false
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { throw '已有 QQ Bot WSLC 操作正在进行。' }
    $null = Invoke-BotWslc @('info')
    # 在任何停止或替换操作之前检查全部容器与网络归属。
    $objects = @{}
    foreach ($key in @('bot','napcat')) {
        $objects[$key] = Get-BotObject container $names[$key]
        Assert-BotOwner $objects[$key] container $names[$key]
    }
    $net = Get-BotObject network $network
    Assert-BotOwner $net network $network
    if ($Action -eq 'Stop') {
        Stop-BotContainer $names.bot
        Stop-BotContainer $names.napcat
        Write-Host 'QQ Bot 与 NapCat 已停止；数据卷和 Orange 服务未删除或修改。'
        return
    }
    if ($Action -eq 'Logs') {
        if ($null -eq $objects[$Service]) { throw '容器尚未部署。' }
        $secretsPath = Join-Path $state 'secrets.json'
        if (Test-Path -LiteralPath $secretsPath) {
            $s = Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json
            $script:SensitiveValues = @($s.webuiToken,$s.onebotToken)
        }
        if (-not $EnvFile) { $EnvFile = Join-Path $repo '.env' }
        if (Test-Path -LiteralPath $EnvFile) {
            $e = Read-BotEnv $EnvFile
            $script:SensitiveValues += @($e.SUB2API_ADMIN_PASSWORD,$e.ONEBOT_ACCESS_TOKEN,$e.NAPCAT_QQ)
        }
        $r = Invoke-BotWslc @('logs','--tail',"$Tail",$names[$Service])
        Write-Output (Protect-BotText $r.Text)
        return
    }
    if ($Action -eq 'Status') {
        foreach ($key in @('napcat','bot')) {
            $obj = $objects[$key]
            [pscustomobject]@{ Service=$key; Name=$names[$key]; State=if ($null -eq $obj) {'not-deployed'} else {$obj.State.Status} }
        }
        $webui = $false
        try { $webui = (Invoke-WebRequest 'http://127.0.0.1:6099' -TimeoutSec 5).StatusCode -eq 200 } catch {}
        if ($null -ne $objects.bot -and $objects.bot.State.Running) {
            $checks = Get-BotChecks $names.bot
            [pscustomobject]@{ WebUI=$webui; Sub2ApiHealth=$checks.api; OneBotConnected=$checks.onebot; QqLoggedIn=$checks.qqLoggedIn }
        } else { [pscustomobject]@{WebUI=$webui;Sub2ApiHealth=$false;OneBotConnected=$false;QqLoggedIn=$false} }
        return
    }
    Get-Command git -ErrorAction Stop | Out-Null
    if ($Build) { & (Join-Path $PSScriptRoot 'wslc-build.ps1') }
    $dirty = @(& git -C $repo status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw '请先完成中文提交，再部署已提交源码。' }
    $commit = (& git -C $repo rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw '无法读取源码提交。' }
    $buildPath = Join-Path $state 'build.json'
    if (-not (Test-Path -LiteralPath $buildPath)) { throw '没有构建记录，请加 -Build 或先运行 wslc-build.ps1。' }
    $metadata = Get-Content -LiteralPath $buildPath -Raw | ConvertFrom-Json
    if ($metadata.commit -ne $commit) { throw '构建记录不对应当前 HEAD，请使用 -Build 重新构建。' }
    $image = $metadata.image
    if ($image -notmatch '^sub2api-qq-bot:wslc-[0-9a-f]{12}$') { throw '构建记录镜像名称不受支持。' }
    $botImage = Get-BotObject image $image
    if ($null -eq $botImage -or $botImage.Id -ne $metadata.imageId -or
        $botImage.Config.Labels.'org.opencontainers.image.revision' -ne $commit) { throw '镜像身份或源码提交与构建记录不一致。' }
    if (-not $EnvFile) { $EnvFile = Join-Path $repo '.env' }
    $envValues = Read-BotEnv $EnvFile
    $script:SensitiveValues = @($envValues.SUB2API_ADMIN_PASSWORD,$envValues.ONEBOT_ACCESS_TOKEN,$envValues.NAPCAT_QQ)
    $account = if ($envValues.ContainsKey('NAPCAT_QQ')) { [string]$envValues.NAPCAT_QQ } else { '' }
    if ($account -and $account -notmatch '^[0-9]{5,12}$') { throw 'NAPCAT_QQ 应为 QQ 号码或留空，不执行其中任何内容。' }
    if (-not $Sub2ApiUrl) {
        $Sub2ApiUrl = if ($envValues.ContainsKey('SUB2API_BASE_URL')) { [string]$envValues.SUB2API_BASE_URL } else { 'http://host.docker.internal:8080' }
    }
    $uri = $null
    if (-not [Uri]::TryCreate($Sub2ApiUrl,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -notin @('http','https') -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'SUB2API_BASE_URL 必须为不含内嵌凭证、查询或片段的 HTTP(S) URL。' }
    if ($uri.Host -in @('host.docker.internal','localhost','127.0.0.1','::1')) {
        if ($uri.Port -ne 8080) { throw '本地 Orange API 必须使用既有 8080，不自动改端口。' }
        $orange = Get-BotObject container 'orange-wslc-app'
        if ($null -eq $orange -or -not $orange.State.Running -or
            $orange.Config.Labels.'org.sub2api.orange.stack' -ne 'wslc-local') {
            throw '未发现正在运行的 Orange WSLC 应用；请提供容器可达的 -Sub2ApiUrl，必要时加 -ApiNetwork。'
        }
        $ApiNetwork = 'orange-wslc-network'
        if ($null -eq $orange.NetworkSettings.Networks.PSObject.Properties[$ApiNetwork]) { throw 'Orange 未连接既有 WSLC 网络，拒绝修改其网络。' }
        $Sub2ApiUrl = 'http://orange-wslc-app:8080' + $uri.AbsolutePath.TrimEnd('/')
    }
    if ($ApiNetwork) {
        if ($ApiNetwork -eq $network -or $null -eq (Get-BotObject network $ApiNetwork)) { throw '额外 API 网络不存在或与机器人网络重复。' }
    }
    $napcat = Get-BotObject image $NapcatImage
    if ($PullNapcat -or $null -eq $napcat) {
        Write-Host "拉取 NapCat 镜像：$NapcatImage"
        $null = Invoke-BotWslc @('pull',$NapcatImage)
        $napcat = Get-BotObject image $NapcatImage
    }
    if ($null -eq $napcat -or $napcat.Id -notmatch '^sha256:[0-9a-f]{64}$') { throw 'NapCat 镜像不可用。' }
    # 运行目录按镜像 ID 隔离：不挂 Windows 二进制，也不让旧运行文件遮蔽镜像更新。
    $volumes = @{
        runtime=('qq-bot-wslc-napcat-' + $napcat.Id.Substring(7,12))
        config='qq-bot-wslc-config'; qq='qq-bot-wslc-qq'; bot='qq-bot-wslc-data'
    }
    foreach ($name in $volumes.Values) { Assert-BotOwner (Get-BotObject volume $name) volume $name }
    if ($null -eq $objects.napcat -or -not $objects.napcat.State.Running) { Assert-BotPort }
    Initialize-BotState $state
    $secretsPath = Join-Path $state 'secrets.json'
    if (Test-Path -LiteralPath $secretsPath) { $secrets = Get-Content -LiteralPath $secretsPath -Raw | ConvertFrom-Json }
    else {
        $secrets = [pscustomobject]@{
            webuiToken=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
            onebotToken=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
        }
        Write-BotJson $secretsPath $secrets
    }
    $onebotToken = if ($envValues.ContainsKey('ONEBOT_ACCESS_TOKEN') -and $envValues.ONEBOT_ACCESS_TOKEN) { [string]$envValues.ONEBOT_ACCESS_TOKEN } else { $secrets.onebotToken }
    $script:SensitiveValues += @($secrets.webuiToken,$secrets.onebotToken,$onebotToken)
    $botEnv = @{}
    foreach ($key in @('SUB2API_ADMIN_EMAIL','SUB2API_ADMIN_PASSWORD','BOT_COMMAND_PREFIX','ADMIN_QQ_LIST','RESPOND_GROUP','RESPOND_PRIVATE')) {
        if ($envValues.ContainsKey($key)) { $botEnv[$key]=$envValues[$key] }
    }
    $botEnv.ONEBOT_WS_URL='ws://napcat:3001'; $botEnv.ONEBOT_ACCESS_TOKEN=$onebotToken
    $botEnv.SUB2API_BASE_URL=$Sub2ApiUrl.TrimEnd('/')
    $napcatEnv = @{ACCOUNT=$account;NAPCAT_UID='0';NAPCAT_GID='0';WEBUI_TOKEN=$secrets.webuiToken}
    $botFile = Join-Path $state 'bot.env'; $napcatFile = Join-Path $state 'napcat.env'
    Write-BotEnv $botFile $botEnv; Write-BotEnv $napcatFile $napcatEnv
    $seed = [ordered]@{
        account=$account
        webui=[ordered]@{host='0.0.0.0';port=6099;token=$secrets.webuiToken;loginRate=3}
        server=[ordered]@{name='qq-bot-wslc';enable=$true;host='0.0.0.0';port=3001;messagePostFormat='array';token=$onebotToken;reportSelfMessage=$false;enableForcePushEvent=$true;debug=$false;heartInterval=30000}
    }
    $seedJson = $seed | ConvertTo-Json -Depth 8 -Compress
    Write-BotJson (Join-Path $state 'config-seed.json') $seed
    $napcatArgs = @('--network',$network,'--network-alias','napcat',
        '--publish','127.0.0.1:6099:6099',
        '--volume',"$($volumes.runtime):/app/napcat",'--volume',"$($volumes.config):/app/napcat/config",
        '--volume',"$($volumes.qq):/app/.config/QQ",'--label',('io.sub2api.qq-bot.seed='+(Get-BotHash $seedJson)),
        '--pull','never',$napcat.Id)
    $botArgs = @('--network',$network,'--network-alias','bot','--volume',"$($volumes.bot):/app/data",'--pull','never',$botImage.Id)
    if ($ApiNetwork) { $botArgs = @('--label',"io.sub2api.qq-bot.api-network=$ApiNetwork") + $botArgs }
    # 资源检查和配置验证完成后才停止自有容器，不触碰 Orange。
    $napcatHash = Get-BotContainerHash $napcatArgs $napcatFile
    if ($null -ne $objects.napcat -and -not (Test-BotContainerMatches $objects.napcat $napcatHash)) {
        Stop-BotContainer $names.napcat
        Assert-BotPort
    }
    foreach ($name in $volumes.Values) {
        if ($null -eq (Get-BotObject volume $name)) {
            $null = Invoke-BotWslc @('volume','create','--label',"$script:StackLabel=$script:StackOwner",$name)
        }
    }
    if ($null -eq $net) { $null = Invoke-BotWslc @('network','create','--label',"$script:StackLabel=$script:StackOwner",$network) }
    if ($state.Contains(',') -or $state.Contains('"')) { throw '状态目录路径不支持逗号或引号。' }
    $null = Invoke-BotWslc @('run','--rm','--network','none','--label',"$script:StackLabel=$script:StackOwner",
        '--volume',"$($volumes.config):/config",'--mount',"type=bind,source=$state,target=/seed,readonly",
        '--entrypoint','node','--pull','never',$botImage.Id,'deploy/seed-config.mjs')
    Ensure-BotContainer $names.napcat $napcatArgs $napcatFile
    Ensure-BotContainer $names.bot $botArgs $botFile
    if ($ApiNetwork) {
        $botNetwork = Get-BotObject container $names.bot
        if ($null -eq $botNetwork.NetworkSettings.Networks.PSObject.Properties[$ApiNetwork]) {
            $null = Invoke-BotWslc @('network','connect',$ApiNetwork,$names.bot)
        }
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $webui = $false
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $running = Get-BotObject container $names.napcat
        if (-not $running.State.Running) { throw 'NapCat 已退出，请用 -Action Logs -Service napcat 查看脱敏日志。' }
        try { $webui = (Invoke-WebRequest 'http://127.0.0.1:6099' -TimeoutSec 5).StatusCode -eq 200 } catch {}
        if ($webui) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $webui) { throw 'NapCat WebUI 启动超时；容器和数据保留以供排查。' }
    $bot = Get-BotObject container $names.bot
    if (-not $bot.State.Running) { throw 'Bot 已退出，请查看脱敏日志。' }
    $checks = Get-BotChecks $names.bot
    Write-BotJson (Join-Path $state 'deploy.json') ([ordered]@{
        image=$image;imageId=$botImage.Id;commit=$commit;napcatImage=$NapcatImage;napcatImageId=$napcat.Id
        network=$network;apiNetwork=$ApiNetwork;volumes=$volumes;webui='http://127.0.0.1:6099'
        apiHealthy=$checks.api;onebotConnected=$checks.onebot;qqLoggedIn=$checks.qqLoggedIn;checkedAt=[DateTime]::UtcNow.ToString('o')
    })
    if (-not $checks.api) { throw '容器与 WebUI 已启动，但 Bot 到 sub2api /health 不通；请检查 API URL/网络，不能视为部署检查通过。' }
    Write-Host 'WSLC 容器、NapCat WebUI 与 sub2api /health 检查通过：http://127.0.0.1:6099'
    if ($checks.qqLoggedIn) { Write-Host 'OneBot 已连接，QQ 登录检查通过；仍需本人测试指令后确认。' }
    else { Write-Host "QQ 尚未通过登录检查，请在 WebUI 登录。登录 token 保存在受保护文件：$secretsPath（webuiToken）。" }
    Write-Host '旧 Windows 数据未动，Orange 仍使用 8080；未推送。'
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
