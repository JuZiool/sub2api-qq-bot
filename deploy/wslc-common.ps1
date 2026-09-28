#requires -Version 7.3
Set-StrictMode -Version Latest
$script:StackLabel = 'io.sub2api.qq-bot.stack'
$script:StackOwner = 'wslc-local'
$script:SensitiveValues = @()

function Protect-BotText {
    param([AllowEmptyString()][string]$Text)
    foreach ($value in $script:SensitiveValues) {
        if (-not [string]::IsNullOrEmpty($value)) { $Text = $Text.Replace($value, '[redacted]') }
    }
    $Text = $Text -replace '(?i)(token=)[^\s&"<>]+', '$1[redacted]'
    return ($Text -replace 'https://txz\.qq\.com/p\?[^\s]+', '[QQ login QR URL redacted]')
}

function Invoke-BotWslc {
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$AllowFailure)
    $output = @(& wslc @Arguments 2>&1)
    $code = $LASTEXITCODE
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "WSLC $($Arguments[0]) 失败（退出码 $code）：$(Protect-BotText $text)"
    }
    [pscustomobject]@{ ExitCode = $code; Text = $text }
}

function Get-BotObject {
    param([ValidateSet('container','network','volume','image')][string]$Type, [string]$Name)
    $arguments = if ($Type -eq 'volume') { @('volume','inspect',$Name) } else { @('inspect','--type',$Type,$Name) }
    $result = Invoke-BotWslc $arguments -AllowFailure
    if ($result.ExitCode -ne 0) {
        if ($result.Text -notmatch '(?i)no such|not found|does not exist|不存在|找不到') {
            throw "无法检查 $Type/$Name：$(Protect-BotText $result.Text)"
        }
        return $null
    }
    $items = @($result.Text | ConvertFrom-Json -Depth 64)
    if ($items.Count -ne 1) { throw "无法确定资源：$Type/$Name" }
    return $items[0]
}

function Assert-BotOwner {
    param($Object, [string]$Type, [string]$Name)
    if ($null -eq $Object) { return }
    $labels = if ($Type -eq 'container') { $Object.Config.Labels } else { $Object.Labels }
    if ($null -eq $labels -or $null -eq $labels.PSObject.Properties[$script:StackLabel] -or
        $labels.$script:StackLabel -ne $script:StackOwner) {
        throw "资源 $Name 不属于 QQ Bot WSLC，拒绝接管、停止或覆盖。"
    }
}

function Read-BotEnv {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "环境文件不存在：$Path" }
    $values = @{}; $lineNumber = 0
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $lineNumber++
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith('#')) { continue }
        if ($text -notmatch '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { throw "环境文件第 $lineNumber 行不是 KEY=VALUE。" }
        $key = $Matches[1]; $value = $Matches[2].Trim()
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            $quote = $value[0]
            $pattern = if ($quote -eq '"') { '^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$' } else { "^'([^']*)'\s*(?:#.*)?$" }
            if ($value -notmatch $pattern) { throw "环境文件第 $lineNumber 行引用不完整。" }
            $value = $Matches[1]
            if ($quote -eq '"') { $value = $value.Replace('\"','"').Replace('\\','\') }
        } else { $value = $value -replace '\s+#.*$','' }
        if ($value -match '[\r\n\x00]') { throw "环境变量 $key 含不支持的控制字符。" }
        $values[$key] = $value
    }
    return $values
}

function Initialize-BotState {
    param([string]$Path)
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls $Path /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '无法限制状态目录权限，拒绝写入密钥。' }
}

function Write-BotJson {
    param([string]$Path, $Value)
    [IO.File]::WriteAllText("$Path.tmp", ($Value | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath "$Path.tmp" -Destination $Path -Force
}

function Write-BotEnv {
    param([string]$Path, [hashtable]$Values)
    $lines = foreach ($key in ($Values.Keys | Sort-Object)) {
        if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or [string]$Values[$key] -match '[\r\n\x00]') { throw '环境变量格式不受支持。' }
        "$key=$($Values[$key])"
    }
    [IO.File]::WriteAllText($Path, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
}

function Get-BotHash {
    param([string]$Text)
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
}

function Assert-BotPort {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,6099)
    $probe.ExclusiveAddressUse = $true
    try { $probe.Start() } catch { throw '6099 已被占用或保留，请先处理；不会自动换端口或停止其它服务。' }
    finally { $probe.Stop() }
}

function Get-BotContainerHash {
    param([string[]]$RunArguments, [string]$EnvFile)
    Get-BotHash (($RunArguments -join "`n") + "`n" + [IO.File]::ReadAllText($EnvFile))
}

function Test-BotContainerMatches {
    param($Object, [string]$Hash)
    if ($null -eq $Object) { return $false }
    $label = $Object.Config.Labels.PSObject.Properties['io.sub2api.qq-bot.config']
    return ($null -ne $label -and $label.Value -eq $Hash)
}

function Stop-BotContainer {
    param([string]$Name)
    $object = Get-BotObject container $Name
    Assert-BotOwner $object container $Name
    if ($null -ne $object -and $object.State.Running) { $null = Invoke-BotWslc @('stop',$Name) }
}

function Ensure-BotContainer {
    param([string]$Name, [string[]]$RunArguments, [string]$EnvFile)
    $hash = Get-BotContainerHash $RunArguments $EnvFile
    $object = Get-BotObject container $Name
    Assert-BotOwner $object container $Name
    if (Test-BotContainerMatches $object $hash) {
        if (-not $object.State.Running) { $null = Invoke-BotWslc @('start',$Name) }
        return
    }
    if ($null -ne $object) {
        Stop-BotContainer $Name
        $null = Invoke-BotWslc @('remove',$Name)
    }
    $null = Invoke-BotWslc (@('run','--detach','--name',$Name,'--label',"$script:StackLabel=$script:StackOwner",
        '--label',"io.sub2api.qq-bot.config=$hash",'--env-file',$EnvFile) + $RunArguments)
}

function Get-BotChecks {
    param([string]$BotName)
    $result = Invoke-BotWslc @('exec',$BotName,'node','deploy/probe.mjs') -AllowFailure
    if ($result.ExitCode -ne 0) { return [pscustomobject]@{api=$false;onebot=$false;qqLoggedIn=$false} }
    return ($result.Text | ConvertFrom-Json)
}