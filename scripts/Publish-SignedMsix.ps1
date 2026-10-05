<#
.SYNOPSIS
    Signs a local Mizan MSIX with Azure Trusted Signing and optionally uploads it.

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Publish-SignedMsix.ps1 -Version 0.1.0
#>

#Requires -Version 7.0

param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [string]$MsixPath = "",
    [string]$Repository = "sabbour/mizan",
    [switch]$Upload,
    [string]$AzureEndpoint = "https://eus.codesigning.azure.net/",
    [string]$AzureCodeSigningAccountName = "asabbour-codesigning",
    [string]$AzureCertificateProfileName = "followcursor-cert",
    [string]$ResourceGroupName = "rg-codesigning",
    [string]$DlibPath = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $MsixPath) { $MsixPath = Join-Path $root "artifacts\Mizan_$($Version)_arm64.msix" }
if (-not (Test-Path $MsixPath -PathType Leaf)) { throw "MSIX was not found: $MsixPath" }

function Find-WindowsSdkTool([string]$Name) {
    $tool = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\$Name"
        "${env:ProgramFiles}\Windows Kits\10\bin\*\x64\$Name"
    ) | ForEach-Object { Resolve-Path $_ -ErrorAction SilentlyContinue } |
        Sort-Object -Descending | Select-Object -First 1
    if (-not $tool) { throw "$Name was not found. Install the Windows SDK." }
    $tool.Path
}

az account show -o none
if ($LASTEXITCODE -ne 0) { throw "Azure CLI is not authenticated. Run 'az login'." }

$accountId = az resource show --resource-group $ResourceGroupName `
    --resource-type Microsoft.CodeSigning/codeSigningAccounts `
    --name $AzureCodeSigningAccountName --query id -o tsv
if ($LASTEXITCODE -ne 0 -or -not $accountId) { throw "Trusted Signing account lookup failed." }
$profile = az resource show --ids "$accountId/certificateProfiles/$AzureCertificateProfileName" `
    --api-version 2024-02-05-preview -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Trusted Signing certificate profile lookup failed." }
$publisher = $profile.properties.certificates[0].subjectName
if (-not $publisher) { throw "The Trusted Signing profile has no active certificate subject." }

$work = Join-Path $env:TEMP "mizan-sign-$Version"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $work | Out-Null
$makeAppx = Find-WindowsSdkTool "MakeAppx.exe"
& $makeAppx unpack /p $MsixPath /d (Join-Path $work "unpacked") /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not inspect the MSIX manifest." }
[xml]$manifest = Get-Content (Join-Path $work "unpacked\AppxManifest.xml") -Raw
if ($manifest.Package.Identity.Publisher -ne $publisher) {
    throw "Manifest publisher '$($manifest.Package.Identity.Publisher)' does not match '$publisher'."
}

if (-not $DlibPath) {
    $dlib = Get-ChildItem "$HOME\.nuget\packages\microsoft.trusted.signing.client" `
        -Filter Azure.CodeSigning.Dlib.dll -Recurse -ErrorAction SilentlyContinue |
        Where-Object FullName -Match '[\\/]x64[\\/]' |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $dlib) {
        $bootstrap = Join-Path $work "signing-client"
        dotnet new classlib --output $bootstrap --force | Out-Null
        dotnet add (Join-Path $bootstrap "signing-client.csproj") package Microsoft.Trusted.Signing.Client
        if ($LASTEXITCODE -ne 0) { throw "Trusted Signing client restore failed." }
        $dlib = Get-ChildItem "$HOME\.nuget\packages\microsoft.trusted.signing.client" `
            -Filter Azure.CodeSigning.Dlib.dll -Recurse |
            Where-Object FullName -Match '[\\/]x64[\\/]' |
            Sort-Object FullName -Descending | Select-Object -First 1
    }
    $DlibPath = $dlib.FullName
}

$metadata = Join-Path $work "metadata.json"
@{
    Endpoint = $AzureEndpoint
    CodeSigningAccountName = $AzureCodeSigningAccountName
    CertificateProfileName = $AzureCertificateProfileName
} | ConvertTo-Json | Set-Content $metadata -Encoding utf8NoBOM

$signTool = Find-WindowsSdkTool "SignTool.exe"
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
