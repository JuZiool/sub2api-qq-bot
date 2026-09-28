#requires -Version 7.3
[CmdletBinding()]
param([switch]$NoCache)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wslc-common.ps1')
if (-not $IsWindows) { throw '本脚本需要 Windows PowerShell 7.3+ 与 WSLC。' }
foreach ($command in @('wslc','git','tar')) { Get-Command $command -ErrorAction Stop | Out-Null }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$state = Join-Path $PSScriptRoot '.wslc'
$mutex = [Threading.Mutex]::new($false, ('Local\QqBotWslcBuild-' + (Get-BotHash $repo).Substring(0,20)))
$locked = $false; $temp = $null
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { throw '已有 QQ Bot WSLC 构建正在进行。' }
    $null = Invoke-BotWslc @('info')
    $dirty = @(& git -C $repo status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw '存在未提交改动或 Git 检查失败，请先完成中文提交。' }
    $commit = (& git -C $repo rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw '无法读取源码提交。' }
    $tracked = @(& git -C $repo ls-tree -r --name-only $commit)
    if ($LASTEXITCODE -ne 0) { throw '无法检查源码快照。' }
    if (@($tracked | Where-Object { $_ -match '^(?:\.env$|\.env\.(?!example$)|data/|node_modules/|deploy/\.wslc/)' }).Count) {
        throw '提交中含私密配置或运行数据，拒绝构建。'
    }
    $image = 'sub2api-qq-bot:wslc-' + $commit.Substring(0,12)
    Initialize-BotState $state
    $temp = Join-Path ([IO.Path]::GetTempPath()) ('qq-bot-wslc-build-' + [guid]::NewGuid().ToString('N'))
    $source = Join-Path $temp 'source'
    [IO.Directory]::CreateDirectory($source) | Out-Null
    $archive = Join-Path $temp 'source.tar'
    & git -C $repo archive --format=tar "--output=$archive" $commit
    if ($LASTEXITCODE -ne 0) { throw '导出已提交源码失败。' }
    & tar -xf $archive -C $source
    if ($LASTEXITCODE -ne 0) { throw '展开源码快照失败。' }
    $arguments = @('build','--progress','plain','--tag',$image,
        '--label',"org.opencontainers.image.revision=$commit",'--label',"$script:StackLabel=$script:StackOwner")
    if ($NoCache) { $arguments += '--no-cache' }
    $arguments += $source
    Write-Host "从已提交源码 $($commit.Substring(0,12)) 构建：$image"
    & wslc @arguments
    if ($LASTEXITCODE -ne 0) { throw '构建失败，未更新构建记录。' }
    $built = Get-BotObject image $image
    if ($null -eq $built) { throw '构建完成但镜像不可用。' }
    Write-BotJson (Join-Path $state 'build.json') ([ordered]@{
        image=$image; imageId=$built.Id; commit=$commit; source='local-git-archive'; builtAt=[DateTime]::UtcNow.ToString('o')
    })
    Write-Host "构建完成：$image"
} finally {
    if ($null -ne $temp -and (Test-Path -LiteralPath $temp)) {
        $resolved = [IO.Path]::GetFullPath($temp)
        $allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        if (-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($resolved) -notmatch '^qq-bot-wslc-build-[0-9a-f]{32}$') { throw '临时路径校验失败，保留文件。' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
