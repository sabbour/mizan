<#
.SYNOPSIS
    Builds the ARM64 or x64 Mizan shell and packages it with the UI and Python host.

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Build-Msix.ps1 -Version 0.1.0 -SkipSign

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Build-Msix.ps1 -Version 0.1.0 -Architecture x64 -SkipSign
#>

#Requires -Version 7.0

param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [ValidateSet("arm64", "x64")]
    [string]$Architecture = "arm64",
    [ValidateRange(0, 65535)]
    [int]$PackageRevision = 0,
    [string]$Publisher = "CN=Ahmed Sabbour, O=Ahmed Sabbour, L=Redmond, S=Washington, C=US",
    [string]$Python = "",
    [string]$BuildId = "",
    [switch]$SkipSign,
    [string]$LocalPfx = "",
    [string]$PfxPassword = ""
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "MizanBuildTools.psm1") -Force
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root "artifacts"
$work = Join-Path $env:TEMP "mizan-msix-build-$PID"
$staging = Join-Path $work "staging"
$publish = Join-Path $work "shell"
$project = Join-Path $root "shell\Mizan.Shell\Mizan.Shell.csproj"
$manifestTemplate = Join-Path $root "shell\Mizan.Shell\Package.appxmanifest"
$taggedBuild = -not [string]::IsNullOrWhiteSpace($BuildId)
if (-not $BuildId) {
    $BuildId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
}
if ($BuildId -notmatch '^\d{8}T\d{6}Z$') {
    throw "BuildId must be a UTC timestamp in yyyyMMddTHHmmssZ format."
}
$Architecture = $Architecture.ToLowerInvariant()
$pythonPlatform = Get-PythonPlatform $Architecture
$output = Get-MsixOutputPath -ArtifactsDirectory $artifacts -Version $Version -Architecture $Architecture `
    -BuildId $(if ($taggedBuild) { $BuildId } else { "" })
Write-Host "Test build identity: $BuildId" -ForegroundColor Cyan

function Invoke-Checked([scriptblock]$Command, [string]$Failure) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw $Failure }
}

function Add-YouTubeJavaScriptRuntime([string]$Destination) {
    $nodeVersion = "24.22.0"
    $archives = @{
        arm64 = @{
            name = "node-v24.22.0-win-arm64.zip"
            sha256 = "3a5c209a5bc59e65b3bc0fa13ed5e166a26bd3d55332847f498b76b037408d61"
        }
        x64 = @{
            name = "node-v24.22.0-win-x64.zip"
            sha256 = "f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3"
        }
    }
    $archive = $archives[$Architecture]
    $archivePath = Join-Path $work $archive.name
    $archiveUrl = "https://nodejs.org/dist/v$nodeVersion/$($archive.name)"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
    $actualHash = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $archive.sha256) {
        throw "The Node.js $nodeVersion runtime archive failed SHA-256 verification."
    }

    $unpacked = Join-Path $work "node-runtime"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $unpacked
    $source = Join-Path $unpacked "node-v$nodeVersion-win-$Architecture"
    $runtime = Join-Path $Destination "js-runtime"
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Copy-Item (Join-Path $source "node.exe") $runtime
    Get-ChildItem $source -Filter "*.dll" -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $runtime
    }
    $node = Join-Path $runtime "node.exe"
    $reportedVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $reportedVersion.Trim() -ne "v$nodeVersion") {
        throw "The bundled Node.js runtime failed its version check."
    }
}

if (-not $Python) { $Python = Join-Path $root "host\.venv\Scripts\python.exe" }
if (-not (Test-Path $Python -PathType Leaf)) {
    throw "$Architecture Python 3.12 was not found: $Python. Run scripts\Initialize-HostEnvironment.ps1 -Architecture $Architecture, or pass -Python."
}
$pythonInfo = Get-PythonIdentity $Python
if ($pythonInfo -ne "3.12|$pythonPlatform") { throw "Packaging requires Python 3.12 $pythonPlatform; found '$pythonInfo' at $Python." }

New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $staging, $publish -Force | Out-Null

$env:PYTHONPATH = Join-Path $root "host"
Invoke-Checked {
    & $Python (Join-Path $root "scripts\credits.py")
} "The package credits could not be generated."

$previousUiVersion = $env:VITE_MIZAN_VERSION
Push-Location (Join-Path $root "ui")
try {
    $env:VITE_MIZAN_VERSION = $Version
    Invoke-Checked { npm.cmd run build } "The UI build failed."
}
finally {
    $env:VITE_MIZAN_VERSION = $previousUiVersion
    Pop-Location
}

Invoke-Checked {
    dotnet publish $project -c Release -r "win-$Architecture" --self-contained true -p:Version=$Version -o $publish
} "The WinUI shell publish failed."

Copy-Item (Join-Path $publish "*") $staging -Recurse -Force
Remove-Item (Join-Path $staging "*.pdb") -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $staging "ui") -Force | Out-Null
Copy-Item (Join-Path $root "ui\dist") (Join-Path $staging "ui\dist") -Recurse -Force
Copy-Item (Join-Path $root "LICENSE"), (Join-Path $root "THIRD_PARTY_NOTICES.md") $staging
Copy-Item (Join-Path $root "licenses") (Join-Path $staging "licenses") -Recurse

Write-Host "Staging Python 3.12 $Architecture runtime..." -ForegroundColor Cyan
Invoke-Checked {
    & $Python (Join-Path $root "scripts\package_python.py") (Join-Path $staging "Python")
} "The Python runtime staging step failed."
Write-Host "Bundling the YouTube JavaScript challenge runtime..." -ForegroundColor Cyan
Add-YouTubeJavaScriptRuntime (Join-Path $staging "Python")
$buildInfoPath = Join-Path $staging "Python\Lib\site-packages\mizan\build_info.json"
$buildInfo = @{ version = $Version; buildId = $BuildId } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText(
    $buildInfoPath,
    $buildInfo,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Generating package assets..." -ForegroundColor Cyan
$assets = Join-Path $staging "Assets"
New-Item -ItemType Directory -Path $assets -Force | Out-Null
Add-Type -AssemblyName System.Drawing.Common
$sourceIcon = [System.Drawing.Icon]::new((Join-Path $root "host\mizan\assets\mizan.ico"))
function Write-Asset([string]$Name, [int]$Width, [int]$Height, [int]$IconSize) {
    $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::FromArgb(255, 247, 243, 235))
        $x = [int](($Width - $IconSize) / 2)
        $y = [int](($Height - $IconSize) / 2)
        $graphics.DrawIcon($sourceIcon, [System.Drawing.Rectangle]::new($x, $y, $IconSize, $IconSize))
        $bitmap.Save((Join-Path $assets $Name), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}
Write-Asset "StoreLogo.png" 50 50 44
Write-Asset "Square44x44Logo.png" 44 44 40
Write-Asset "Square150x150Logo.png" 150 150 112
Write-Asset "Square310x310Logo.png" 310 310 220
Write-Asset "Wide310x150Logo.png" 310 150 112
Write-Asset "SplashScreen.png" 620 300 180
$sourceIcon.Dispose()

$manifest = Get-Content $manifestTemplate -Raw
$manifest = $manifest -replace '(<Identity[^>]*?)Version="[^"]*"', "`$1Version=`"$Version.$PackageRevision`""
$manifest = $manifest -replace '(<Identity[^>]*?)Publisher="[^"]*"', "`$1Publisher=`"$Publisher`""
$manifest = $manifest -replace '(<Identity[^>]*?)ProcessorArchitecture="[^"]*"', "`$1ProcessorArchitecture=`"$Architecture`""
[System.IO.File]::WriteAllText(
    (Join-Path $staging "AppxManifest.xml"),
    $manifest,
    [System.Text.UTF8Encoding]::new($false)
)

$makeAppx = Find-WindowsSdkTool "MakeAppx.exe"
& $makeAppx pack /d $staging /p $output /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed." }

if ($SkipSign) {
    Remove-Item $work -Recurse -Force
    Write-Host "Built unsigned MSIX: $output" -ForegroundColor Green
    return
}
if (-not $LocalPfx) {
    throw "Pass -SkipSign, or provide -LocalPfx. Use Publish-SignedMsix.ps1 for Azure Trusted Signing."
}
$signTool = Find-WindowsSdkTool "SignTool.exe"
$arguments = @("sign", "/v", "/fd", "SHA256", "/f", $LocalPfx)
if ($PfxPassword) { $arguments += @("/p", $PfxPassword) }
$arguments += @("/tr", "http://timestamp.digicert.com", "/td", "SHA256", $output)
& $signTool @arguments
if ($LASTEXITCODE -ne 0) { throw "Development certificate signing failed." }
Remove-Item $work -Recurse -Force
Write-Host "Built signed MSIX: $output" -ForegroundColor Green
