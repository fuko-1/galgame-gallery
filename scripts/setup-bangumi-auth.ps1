param([switch]$GitHub)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
if (-not $env:LOCALAPPDATA) { throw '此设置脚本需要 Windows；其他系统请使用 BANGUMI_ACCESS_TOKEN 环境变量。' }

$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'galgame-gallery'
$credentialFile = Join-Path $credentialDirectory 'bangumi-token.dpapi'
Write-Host '在 https://bgm.tv/dev/app 登录 koberi，创建 Access Token。'
Write-Host '输入会隐藏；令牌由 Windows 加密保存在网站目录之外。不要把令牌发到聊天或写入 config.json。'
if ($GitHub) {
    Write-Host '本次还会将令牌保存为 fuko-1/galgame-gallery 的 GitHub Actions Secret BANGUMI_ACCESS_TOKEN。'
    & gh auth status
    if ($LASTEXITCODE -ne 0) { throw '请先登录 GitHub CLI 后重试。' }
}

$secureToken = Read-Host '粘贴 Bangumi Access Token 后按回车' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    # stdin keeps credentials out of command arguments, history and logs.
    $plainToken | & node --use-env-proxy (Join-Path $PSScriptRoot 'check-bangumi-auth.mjs') --stdin
    if ($LASTEXITCODE -ne 0) { throw '授权检查未通过，未保存令牌。' }
    New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
    $encryptedToken = ConvertFrom-SecureString $secureToken
    [IO.File]::WriteAllText($credentialFile, $encryptedToken, [Text.UTF8Encoding]::new($false))
    Write-Host '本地授权已加密保存。以后更新会自动读取。'
    if ($GitHub) {
        $plainToken | & gh secret set BANGUMI_ACCESS_TOKEN --repo fuko-1/galgame-gallery
        if ($LASTEXITCODE -ne 0) { throw '本地已保存，但 GitHub Secret 设置失败；修复 GitHub 登录后重试。' }
        Write-Host 'GitHub Actions 授权已保存。合并当前 PR 后，每日更新会自动使用。'
    }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    $plainToken = $null
    $secureToken.Dispose()
}
Write-Host '正在补全首批缺失封面，优先处理推荐游戏……'
& node --use-env-proxy (Join-Path $PSScriptRoot 'fetch-galgame.mjs') --enrich-only
if ($LASTEXITCODE -ne 0) { throw '授权已保存，但封面补全失败；检查网络后运行 npm run fetch:covers 重试。' }
