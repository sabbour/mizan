# Tool discovery shared by the MSIX build, signing, and host setup scripts.
# Functions only read the machine state they are asked about. They never
# install, sign, upload, change accounts, or edit global configuration.

function Get-HostArchitecture {
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($architecture) {
        "Arm64" { "arm64" }
        "X64" { "x64" }
        default { throw "Unsupported Windows build host architecture: $architecture." }
    }
}

# Build-host tools, not the package target. ARM64 Windows also runs x64 tools.
function Get-HostToolArchitectures([string]$HostArchitecture = (Get-HostArchitecture)) {
    if ($HostArchitecture -eq "arm64") { @("arm64", "x64") } else { @("x64") }
}

function Get-DefaultWindowsSdkRoots {
    foreach ($programFiles in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if ($programFiles) { Join-Path $programFiles "Windows Kits\10\bin" }
    }
}

function Find-WindowsSdkTool {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string[]]$ToolArchitectures = (Get-HostToolArchitectures),
        [string[]]$SdkRoots = @(Get-DefaultWindowsSdkRoots)
    )
    $sdks = foreach ($sdkRoot in $SdkRoots) {
        if (-not (Test-Path -LiteralPath $sdkRoot -PathType Container)) { continue }
        foreach ($directory in Get-ChildItem -LiteralPath $sdkRoot -Directory) {
            $version = $null
            if ([version]::TryParse($directory.Name, [ref]$version)) {
                [pscustomobject]@{ Version = $version; Path = $directory.FullName }
            }
        }
    }
    foreach ($sdk in @($sdks | Sort-Object Version -Descending)) {
        foreach ($architecture in $ToolArchitectures) {
            $tool = Join-Path $sdk.Path "$architecture\$Name"
            if (Test-Path -LiteralPath $tool -PathType Leaf) { return $tool }
        }
    }
    throw "$Name ($($ToolArchitectures -join ' or ')) was not found in the Windows SDK. Install the Windows SDK."
}

function ConvertFrom-NuGetLocalsOutput([string[]]$Lines) {
    foreach ($line in $Lines) {
        if ($line -match '^\s*global-packages:\s*(.+?)\s*$') { return $Matches[1].TrimEnd("\", "/") }
    }
    throw "Could not read the NuGet global-packages folder from 'dotnet nuget locals global-packages --list'."
}

# Honors NUGET_PACKAGES and nuget.config files that apply to WorkingDirectory.
function Get-NuGetGlobalPackagesPath([string]$WorkingDirectory = (Get-Location).Path) {
    if (-not (Get-Command dotnet -CommandType Application -ErrorAction SilentlyContinue)) {
        throw "The .NET SDK was not found on PATH. Install it, or pass -DlibPath."
    }
    Push-Location -LiteralPath $WorkingDirectory
    try { $output = @(& dotnet nuget locals global-packages --list 2>&1 | ForEach-Object { "$_" }) }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "'dotnet nuget locals global-packages --list' failed: $($output -join ' ')" }
    ConvertFrom-NuGetLocalsOutput -Lines $output
}

function Find-TrustedSigningDlib {
    param(
        [Parameter(Mandatory)][string]$PackagesRoot,
        [string]$Architecture = "x64"
    )
    $packageDirectory = Join-Path $PackagesRoot "microsoft.trusted.signing.client"
    if (-not (Test-Path -LiteralPath $packageDirectory -PathType Container)) { return $null }
    $candidates = foreach ($directory in Get-ChildItem -LiteralPath $packageDirectory -Directory) {
        $version = $null
        if (-not [version]::TryParse($directory.Name, [ref]$version)) { continue }
        $dlib = Join-Path $directory.FullName "bin\$Architecture\Azure.CodeSigning.Dlib.dll"
        if (Test-Path -LiteralPath $dlib -PathType Leaf) {
            [pscustomobject]@{ Version = $version; Path = $dlib }
        }
    }
    $selected = @($candidates | Sort-Object Version -Descending | Select-Object -First 1)
    if ($selected.Count) { $selected[0].Path } else { $null }
}

# Reads the exact package folder and version that a restore used.
function Find-TrustedSigningDlibFromAssets {
    param(
        [Parameter(Mandatory)][string]$AssetsPath,
        [string]$Architecture = "x64"
    )
    $assets = Get-Content -LiteralPath $AssetsPath -Raw | ConvertFrom-Json -AsHashtable
    $library = @($assets["libraries"].Keys | Where-Object { $_ -like "Microsoft.Trusted.Signing.Client/*" })
    if ($library.Count -ne 1) { throw "The restore did not resolve exactly one Microsoft.Trusted.Signing.Client package." }
    $relative = $assets["libraries"][$library[0]]["path"]
    foreach ($folder in $assets["packageFolders"].Keys) {
        $dlib = Join-Path (Join-Path $folder $relative) "bin\$Architecture\Azure.CodeSigning.Dlib.dll"
        if (Test-Path -LiteralPath $dlib -PathType Leaf) { return $dlib }
    }
    throw "Restored $($library[0]) has no $Architecture Azure.CodeSigning.Dlib.dll."
}

function Resolve-TrustedSigningDlib {
    param(
        [string]$DlibPath = "",
        [Parameter(Mandatory)][string]$WorkDirectory,
        [Parameter(Mandatory)][string]$RepositoryRoot
    )
    if ($DlibPath) {
        if (-not (Test-Path -LiteralPath $DlibPath -PathType Leaf)) { throw "The -DlibPath file was not found: $DlibPath" }
        return (Resolve-Path -LiteralPath $DlibPath).Path
    }
    $dlib = Find-TrustedSigningDlib -PackagesRoot (Get-NuGetGlobalPackagesPath -WorkingDirectory $RepositoryRoot)
    if ($dlib) { return $dlib }

    Write-Host "Restoring Microsoft.Trusted.Signing.Client from your configured NuGet sources..." -ForegroundColor Cyan
    $bootstrap = Join-Path $WorkDirectory "signing-client"
    & dotnet new classlib --output $bootstrap --force | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create the Trusted Signing restore project." }
    & dotnet add (Join-Path $bootstrap "signing-client.csproj")     package Microsoft.Trusted.Signing.Client | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Trusted Signing client restore failed. Check your NuGet sources and sign-in, or pass -DlibPath."
    }
    Find-TrustedSigningDlibFromAssets -AssetsPath (Join-Path $bootstrap "obj\project.assets.json")
}

function Get-TrustedSigningPublisher {
    param(
        [Parameter(Mandatory)][string]$ResourceGroupName,
        [Parameter(Mandatory)][string]$AccountName,
        [Parameter(Mandatory)][string]$CertificateProfileName
    )
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw "Azure CLI was not found. Install it, then run 'az login'." }
    az account show -o none
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI is not authenticated. Run 'az login'." }
    $accountId = az resource show --resource-group $ResourceGroupName `
        --resource-type Microsoft.CodeSigning/codeSigningAccounts `
        --name $AccountName --query id -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $accountId) { throw "Trusted Signing account lookup failed." }
    $certificateProfile = az resource show --ids "$accountId/certificateProfiles/$CertificateProfileName" `
        --api-version 2024-02-05-preview -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Trusted Signing certificate profile lookup failed." }
    $publisher = $certificateProfile.properties.certificates[0].subjectName
    if (-not $publisher) { throw "The Trusted Signing profile has no active certificate subject." }
    $publisher
}

function Get-MsixOutputPath {
    param(
        [Parameter(Mandatory)][string]$ArtifactsDirectory,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][ValidateSet("arm64", "x64")][string]$Architecture,
        [string]$BuildId = ""
    )
    $architectureName = $Architecture.ToLowerInvariant()
    $name = if ($BuildId) { "Mizan_$($Version)_$($BuildId)_$architectureName.msix" } else { "Mizan_$($Version)_$architectureName.msix" }
    Join-Path $ArtifactsDirectory $name
}

function Get-PythonPlatform([ValidateSet("arm64", "x64")][string]$Architecture) {
    @{ arm64 = "win-arm64"; x64 = "win-amd64" }[$Architecture]
}

function Get-PythonIdentity([string]$Python) {
    $info = & $Python -c "import sys,sysconfig; print(f'{sys.version_info.major}.{sys.version_info.minor}|{sysconfig.get_platform()}')" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    "$info".Trim()
}

function Get-PythonCandidates {
    $launcher = Get-Command py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($launcher) {
        foreach ($line in @(& $launcher.Source -0p 2>$null)) {
            if ("$line" -match '([A-Za-z]:\\.+?python\.exe)\s*$') { $Matches[1] }
        }
    }
    foreach ($base in @((Join-Path $env:LOCALAPPDATA "Programs\Python"), $env:ProgramFiles)) {
        if ($base) {
            Join-Path $base "Python312-arm64\python.exe"
            Join-Path $base "Python312\python.exe"
        }
    }
}

function Find-Python312 {
    param(
        [Parameter(Mandatory)][ValidateSet("arm64", "x64")][string]$Architecture,
        [string[]]$Candidates = @(Get-PythonCandidates)
    )
    $expected = "3.12|$(Get-PythonPlatform $Architecture)"
    $seen = @{}
    foreach ($candidate in $Candidates) {
        if (-not $candidate -or $seen.ContainsKey($candidate)) { continue }
        $seen[$candidate] = $true
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Get-PythonIdentity $candidate) -eq $expected) {
            return $candidate
        }
    }
    throw "Python 3.12 for $Architecture ($(Get-PythonPlatform $Architecture)) was not found. Install the $Architecture Python 3.12 from python.org, or pass -Python with its python.exe path."
}

function Test-GitExecPathMatches {
    param(
        [Parameter(Mandatory)][string]$GitPath,
        [string]$ExecPath = ""
    )
    if (-not $ExecPath) { return $true }
    $installRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $GitPath))).TrimEnd("\") + "\"
    $execRoot = [System.IO.Path]::GetFullPath($ExecPath).TrimEnd("\") + "\"
    $execRoot.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

# Clears an inherited GIT_EXEC_PATH that belongs to another Git, for this
# process only, and returns the removed value so the caller can restore it.
function Initialize-GitEnvironment {
    $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) { throw "Git was not found on PATH. Install Git for Windows; pip needs it for the pinned GitHub dependencies." }
    $removed = $null
    if ($env:GIT_EXEC_PATH -and -not (Test-GitExecPathMatches -GitPath $git.Source -ExecPath $env:GIT_EXEC_PATH)) {
        Write-Warning "Ignoring GIT_EXEC_PATH for this setup because it belongs to a different Git than $($git.Source)."
        $removed = $env:GIT_EXEC_PATH
        Remove-Item Env:GIT_EXEC_PATH
    }
    $execPath = "$(& $git.Source --exec-path)".Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $execPath "git-remote-https.exe") -PathType Leaf)) {
        if ($removed) { $env:GIT_EXEC_PATH = $removed }
        throw "Git at $($git.Source) cannot run git-remote-https. Repair Git for Windows, or put a complete Git first on PATH."
    }
    [pscustomobject]@{ Git = $git.Source; RemovedExecPath = $removed }
}

Export-ModuleMember -Function *
