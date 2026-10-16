<#
.SYNOPSIS
    Creates host\.venv with Python 3.12 for the target architecture and installs
    the host development dependencies.

.DESCRIPTION
    Finds an installed Python 3.12 that matches the architecture, creates the
    virtual environment, and installs host[dev] plus the pinned MuScriptor
    source with pip. pip uses this machine's pip configuration (index, proxy,
    credentials); this script never passes an index URL. It does not install
    Python, change PATH, or edit global Git or pip settings. An inherited
    GIT_EXEC_PATH that belongs to a different Git is ignored for this process only.

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Initialize-HostEnvironment.ps1

.EXAMPLE
    pwsh -NoProfile -File .\scripts\Initialize-HostEnvironment.ps1 -Architecture x64 -Python C:\Python312\python.exe
#>

#Requires -Version 7.0

param(
    [string]$Architecture = "",
    [string]$Python = "",
    [string]$VenvPath = ""
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "MizanBuildTools.psm1") -Force
$root = Split-Path -Parent $PSScriptRoot
if (-not $Architecture) { $Architecture = Get-HostArchitecture }
$Architecture = $Architecture.ToLowerInvariant()
if ($Architecture -notin @("arm64", "x64")) { throw "Architecture must be arm64 or x64." }
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
$git = Initialize-GitEnvironment
try {
    & $venvPython -m pip install -e "$(Join-Path $root 'host')[dev]"
    if ($LASTEXITCODE -ne 0) { throw $pipFailure }
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
