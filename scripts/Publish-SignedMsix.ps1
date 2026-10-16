<#
.SYNOPSIS
    Signs a local Mizan MSIX with Azure Trusted Signing and optionally uploads it.

.DESCRIPTION
    Discovers the Windows SDK, the NuGet global-packages folder, and the Trusted
    Signing client from this machine's configuration. With -Build, it first
    builds the package with the publisher from the active certificate profile,
    then signs that exact output.

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Publish-SignedMsix.ps1 -Version 0.1.0 -Architecture x64 -Build

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Publish-SignedMsix.ps1 -Version 0.1.0
#>

#Requires -Version 7.0

param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [string]$MsixPath = "",
    [ValidateSet("arm64", "x64")]
    [string]$Architecture = "arm64",
    [switch]$Build,
    [string]$BuildId = "",
    [string]$Python = "",
    [string]$Repository = "sabbour/mizan",
    [switch]$Upload,
    [string]$AzureEndpoint = "https://eus.codesigning.azure.net/",
    [string]$AzureCodeSigningAccountName = "asabbour-codesigning",
    [string]$AzureCertificateProfileName = "followcursor-cert",
    [string]$ResourceGroupName = "rg-codesigning",
    [string]$DlibPath = ""
)

$ErrorActionPreference = "Stop"
if ($Upload -and ($env:MIZAN_BINARY_DISTRIBUTION_READY -cne "true")) {
    throw "Public installer uploads are blocked. Review docs\releasing.md, then set MIZAN_BINARY_DISTRIBUTION_READY=true only after the redistribution requirements are met."
}
Import-Module (Join-Path $PSScriptRoot "MizanBuildTools.psm1") -Force
$root = Split-Path -Parent $PSScriptRoot
if ($Build -and $MsixPath) { throw "Use -Build or -MsixPath, not both." }
if (-not $MsixPath) {
    $MsixPath = Get-MsixOutputPath -ArtifactsDirectory (Join-Path $root "artifacts") `
        -Version $Version -Architecture $Architecture -BuildId $BuildId
}
if (-not $Build -and -not (Test-Path $MsixPath -PathType Leaf)) { throw "MSIX was not found: $MsixPath" }
if ($DlibPath -and -not (Test-Path -LiteralPath $DlibPath -PathType Leaf)) { throw "The -DlibPath file was not found: $DlibPath" }

$publisher = Get-TrustedSigningPublisher -ResourceGroupName $ResourceGroupName `
    -AccountName $AzureCodeSigningAccountName -CertificateProfileName $AzureCertificateProfileName

if ($Build) {
    $buildArguments = @{ Version = $Version; Architecture = $Architecture; Publisher = $publisher; SkipSign = $true }
    if ($BuildId) { $buildArguments.BuildId = $BuildId }
    if ($Python) { $buildArguments.Python = $Python }
    & (Join-Path $PSScriptRoot "Build-Msix.ps1") @buildArguments
    if (-not (Test-Path $MsixPath -PathType Leaf)) { throw "The build did not produce the expected MSIX: $MsixPath" }
}

$work = Join-Path $env:TEMP "mizan-sign-$Version"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $work | Out-Null
$makeAppx = Find-WindowsSdkTool "MakeAppx.exe"
& $makeAppx unpack /p $MsixPath /d (Join-Path $work "unpacked") /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not inspect the MSIX manifest." }
[xml]$manifest = Get-Content (Join-Path $work "unpacked\AppxManifest.xml") -Raw
if ($manifest.Package.Identity.Publisher -ne $publisher) {
    throw "Manifest publisher '$($manifest.Package.Identity.Publisher)' does not match '$publisher'. Rebuild with -Build."
}

$DlibPath = Resolve-TrustedSigningDlib -DlibPath $DlibPath -WorkDirectory $work -RepositoryRoot $root
Write-Host "Trusted Signing client: $DlibPath" -ForegroundColor Cyan

$metadata = Join-Path $work "metadata.json"
@{
    Endpoint = $AzureEndpoint
    CodeSigningAccountName = $AzureCodeSigningAccountName
    CertificateProfileName = $AzureCertificateProfileName
} | ConvertTo-Json | Set-Content $metadata -Encoding utf8NoBOM

# The Trusted Signing dlib is x64, so SignTool must be x64 too. ARM64 Windows runs it under emulation.
$signTool = Find-WindowsSdkTool "SignTool.exe" -ToolArchitectures x64
& $signTool sign /v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
    /dlib $DlibPath /dmdf $metadata $MsixPath
if ($LASTEXITCODE -ne 0) { throw "Azure Trusted Signing failed." }
& $signTool verify /pa /v $MsixPath
if ($LASTEXITCODE -ne 0) { throw "SignTool verification failed." }

if ($Upload) {
    gh release upload "v$Version" $MsixPath --repo $Repository --clobber
    if ($LASTEXITCODE -ne 0) { throw "GitHub release upload failed." }
}
Remove-Item $work -Recurse -Force
Write-Host "Signed and verified: $MsixPath" -ForegroundColor Green
