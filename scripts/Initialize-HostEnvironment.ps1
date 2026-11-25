<#
.SYNOPSIS
    Creates host\.venv with Python 3.12 for the target architecture and installs
    the host development dependencies.

.DESCRIPTION
    Finds an installed Python 3.12 that matches the architecture, creates the
    virtual environment, and installs host[dev] plus the pinned MuScriptor
    source. Pass -Probe to include the provider probe dependencies. Native
    Python uses pip and its configured index. On ARM64 Windows, x64 Python
    uses uv with an explicit x64 target to resolve dependencies.

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Initialize-HostEnvironment.ps1

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Initialize-HostEnvironment.ps1 -Architecture x64 -Python C:\Python312\python.exe
#>

#Requires -Version 7.0

param(
    [string]$Architecture = "",
    [string]$Python = "",
    [string]$VenvPath = "",
    [switch]$Probe
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "MizanBuildTools.psm1") -Force
$root = Split-Path -Parent $PSScriptRoot
$hostArchitecture = Get-HostArchitecture
if (-not $Architecture) { $Architecture = $hostArchitecture }
$Architecture = $Architecture.ToLowerInvariant()
if ($Architecture -notin @("arm64", "x64")) { throw "Architecture must be arm64 or x64." }
$emulatedX64 = $hostArchitecture -eq "arm64" -and $Architecture -eq "x64"
if ($emulatedX64) {
    $uv = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $uv) { throw "Install uv and add it to PATH to install x64 dependencies on ARM64 Windows." }
}
if (-not $VenvPath) { $VenvPath = Join-Path $root "host\.venv" }
$expected = "3.12|$(Get-PythonPlatform $Architecture)"
$venvPython = Join-Path $VenvPath "Scripts\python.exe"

if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
    $found = Get-PythonIdentity $venvPython
    if ($found -ne $expected) {
        throw "$VenvPath uses '$found', not '$expected'. Remove it or pass -VenvPath, then run this script again."
    }
    Write-Host "Using existing $VenvPath ($expected)." -ForegroundColor Cyan
} elseif (Test-Path -LiteralPath $VenvPath) {
    throw "$VenvPath exists but has no Scripts\python.exe. Remove it, then run this script again."
} else {
    if ($Python) {
        if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw "The -Python file was not found: $Python" }
        $found = Get-PythonIdentity $Python
        if ($found -ne $expected) { throw "-Python is '$found', not '$expected'." }
    } else {
        $Python = Find-Python312 -Architecture $Architecture
    }
    Write-Host "Creating $VenvPath with $Python..." -ForegroundColor Cyan
    & $Python -m venv $VenvPath
    if ($LASTEXITCODE -ne 0) { throw "Virtual environment creation failed." }
}

$pipFailure = "pip install failed. pip uses your configured package index (see 'pip config list'); check that it is reachable and that you are signed in. " +
    "The pinned GitHub and download-r2.pytorch.org dependencies are direct URLs outside that index, so this machine also needs access to those hosts."
$extras = if ($Probe) { "dev,probe" } else { "dev" }
$hostRequirement = "$(Join-Path $root 'host')[$extras]"
$git = Initialize-GitEnvironment
try {
    if ($emulatedX64) {
        & $uv.Source pip install --python $venvPython --python-platform x86_64-pc-windows-msvc --system-certs -e $hostRequirement
        if ($LASTEXITCODE -ne 0) { throw "uv install failed. If you use a private package index, configure it for uv with UV_DEFAULT_INDEX." }
    } else {
        & $venvPython -m pip install -e $hostRequirement
        if ($LASTEXITCODE -ne 0) { throw $pipFailure }
    }
    $muscriptor = & $venvPython -c "import sys, tomllib; print(tomllib.load(open(sys.argv[1], 'rb'))['tool']['mizan']['muscriptor-inference-source'])" (Join-Path $root "host\pyproject.toml")
    if ($LASTEXITCODE -ne 0 -or -not $muscriptor) { throw "Could not read [tool.mizan].muscriptor-inference-source from host\pyproject.toml." }
    $muscriptor = "$muscriptor".Trim()
    # MuScriptor's upstream extras pull torchaudio, which has no Windows ARM64 wheel.
    & $venvPython -m pip install --no-deps $muscriptor
    if ($LASTEXITCODE -ne 0) { throw $pipFailure }
}
finally {
    if ($git.RemovedExecPath) { $env:GIT_EXEC_PATH = $git.RemovedExecPath }
}
Write-Host "Host environment ready: $venvPython" -ForegroundColor Green
