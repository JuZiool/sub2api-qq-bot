#requires -Version 7.3
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../wslc-common.ps1')
$script:passed = 0
function Assert-Test([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "失败：$Message" }
    $script:passed++
    Write-Host "通过：$Message"
}
function Assert-Throws([scriptblock]$Code, [string]$Pattern, [string]$Message) {
    $caught = $null
    try { & $Code } catch { $caught=$_.Exception.Message }
    Assert-Test ($null -ne $caught -and $caught -match $Pattern) $Message
}
$temp = Join-Path ([IO.Path]::GetTempPath()) ('qq-bot-wslc-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
$script:mockObject = $null; $script:mockError = ''; $script:calls = [Collections.Generic.List[string]]::new()
function wslc {
    $script:calls.Add(($args -join '|'))
    if ($args[0] -eq 'inspect' -or ($args[0] -eq 'volume' -and $args[1] -eq 'inspect')) {
        if ($script:mockError) { $global:LASTEXITCODE=1; Write-Output $script:mockError; return }
        if ($null -eq $script:mockObject) { $global:LASTEXITCODE=1; Write-Output '找不到对象'; return }
        $global:LASTEXITCODE=0; Write-Output (ConvertTo-Json -InputObject @($script:mockObject) -Depth 10 -Compress); return
    }
    $global:LASTEXITCODE=0
}
try {
    $envPath = Join-Path $temp 'test.env'
    [IO.File]::WriteAllLines($envPath, @('export A="hello # world" # note', "B='`$(not-executed)'",'C=plain # note','D=','TOKEN=a=b=c'))
    $envValues = Read-BotEnv $envPath
    Assert-Test ($envValues.A -eq 'hello # world' -and $envValues.B -eq '$(not-executed)') '引用与变量表达式只作为文本'
    Assert-Test ($envValues.C -eq 'plain' -and $envValues.D -eq '' -and $envValues.TOKEN -eq 'a=b=c') '注释、空值及等号解析'
    [IO.File]::WriteAllText($envPath,"SECRET=`"unclosed")
    Assert-Throws {Read-BotEnv $envPath} '引用不完整' '拒绝不完整引用，不泄露原值'
    Assert-Throws {Write-BotEnv $envPath @{A="bad`nvalue"}} '格式' '阻止环境文件换行注入'
    $script:SensitiveValues=@('top-secret')
    Assert-Test ((Protect-BotText 'password top-secret token=abc123&x=1') -eq 'password [redacted] token=[redacted]&x=1') '日志密码与 URL token 脱敏'
    $foreign=[pscustomobject]@{Config=[pscustomobject]@{Labels=[pscustomobject]@{}}}
    Assert-Throws {Assert-BotOwner $foreign container foreign} '不属于' '拒绝接管外部同名容器'
    $owned=[pscustomobject]@{Config=[pscustomobject]@{Labels=[pscustomobject]@{'io.sub2api.qq-bot.stack'='wslc-local'}};State=[pscustomobject]@{Running=$true}}
    Assert-BotOwner $owned container owned
    Assert-Test $true '允许自有资源'
    $volume=[pscustomobject]@{Labels=[pscustomobject]@{'io.sub2api.qq-bot.stack'='other'}}
    Assert-Throws {Assert-BotOwner $volume volume foreign} '不属于' '数据卷归属保护'
    $script:mockError='WSLC service unavailable'
    Assert-Throws {Get-BotObject container x} '无法检查' '服务错误不得误判为资源不存在'
    $script:mockError=''; $script:mockObject=$null
    Assert-Test ($null -eq (Get-BotObject container x)) '明确不存在的对象返回空值'
    $script:mockObject=$foreign; $script:calls.Clear()
    Write-BotEnv $envPath @{A='one'}
    Assert-Throws {Ensure-BotContainer 'foreign' @('image') $envPath} '不属于' '重部署拒绝覆盖外部容器'
    Assert-Test (@($script:calls | Where-Object {$_ -match '^(stop|remove|run)\|'}).Count -eq 0) '拒绝后没有停止或删除调用'
    $hash=Get-BotContainerHash @('image') $envPath
    $owned.Config.Labels | Add-Member -NotePropertyName 'io.sub2api.qq-bot.config' -NotePropertyValue $hash
    $script:mockObject=$owned; $script:calls.Clear()
    Ensure-BotContainer 'owned' @('image') $envPath
    Assert-Test (@($script:calls | Where-Object {$_ -match '^(stop|remove|run|start)\|'}).Count -eq 0) '同配置运行中重部署不重建'
    $owned.State.Running=$false; $script:calls.Clear()
    Ensure-BotContainer 'owned' @('image') $envPath
    Assert-Test (@($script:calls | Where-Object {$_ -eq 'start|owned'}).Count -eq 1) '同配置已停止容器仅启动'
    Write-BotEnv $envPath @{A='changed'}; $script:calls.Clear()
    Ensure-BotContainer 'owned' @('image') $envPath
    Assert-Test (@($script:calls | Where-Object {$_ -eq 'remove|owned'}).Count -eq 1) '配置变化可重建容器'
    Assert-Test (@($script:calls | Where-Object {$_ -match '\|(--volumes|-v)\|'}).Count -eq 0) '重建从不删除持久化卷'
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,6099)
    $listener.ExclusiveAddressUse=$true
    try { $listener.Start(); Assert-Throws {Assert-BotPort} '6099' 'WebUI 端口冲突拒绝自动换端口' }
    finally { $listener.Stop() }
    $repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $ignore=[IO.File]::ReadAllText((Join-Path $repo '.dockerignore'))
    Assert-Test ($ignore -match '(?m)^\.env$' -and $ignore -match '(?m)^data$' -and $ignore -match 'deploy/\.wslc') '构建排除凭证、旧数据与部署状态'
    $build=[IO.File]::ReadAllText((Join-Path $repo 'deploy/wslc-build.ps1'))
    Assert-Test ($build.Contains('archive --format=tar') -and $build.Contains('status --porcelain')) '仅从已提交 Git 快照构建'
    Write-Host "全部通过：$script:passed 项检查；未访问真实 WSLC 资源。"
} finally {
    Remove-Item -LiteralPath Function:wslc -ErrorAction SilentlyContinue
    $resolved=[IO.Path]::GetFullPath($temp)
    $root=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notmatch '^qq-bot-wslc-test-[0-9a-f]{32}$') {throw '测试临时路径不安全，保留文件。'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
