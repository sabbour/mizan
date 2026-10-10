param(
    [string]$ExpectedVersion = '0.2.30.16',
    [string]$Output = (Join-Path $PSScriptRoot 'native-launch-runtime.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace MizanVerification {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        void ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options, out uint processId);
        void ActivateForFile(
            [MarshalAs(UnmanagedType.LPWStr)] string appId,
            IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string verb,
            out uint processId);
        void ActivateForProtocol(
            [MarshalAs(UnmanagedType.LPWStr)] string appId,
            IntPtr items, out uint processId);
    }

    public static class Activation {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHCreateItemFromParsingName(
            string path, IntPtr context, ref Guid iid, out IntPtr item);
        [DllImport("shell32.dll")]
        static extern int SHCreateShellItemArrayFromShellItem(
            IntPtr item, ref Guid iid, out IntPtr items);
        [DllImport("ole32.dll")]
        static extern int CoAllowSetForegroundWindow(IntPtr unknown, IntPtr reserved);

        public static uint OpenFile(string appId, string path) {
            var manager = (IApplicationActivationManager)Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
            IntPtr item = IntPtr.Zero, items = IntPtr.Zero;
            var managerPointer = Marshal.GetIUnknownForObject(manager);
            try {
                Marshal.ThrowExceptionForHR(CoAllowSetForegroundWindow(managerPointer, IntPtr.Zero));
                var itemId = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(
                    path, IntPtr.Zero, ref itemId, out item));
                var arrayId = new Guid("B63EA76D-1F85-456F-A19C-48159EFA858B");
                Marshal.ThrowExceptionForHR(SHCreateShellItemArrayFromShellItem(
                    item, ref arrayId, out items));
                manager.ActivateForFile(appId, items, "open", out var processId);
                return processId;
            } finally {
                if (items != IntPtr.Zero) Marshal.Release(items);
                if (item != IntPtr.Zero) Marshal.Release(item);
                Marshal.Release(managerPointer);
                Marshal.FinalReleaseComObject(manager);
            }
        }
    }
}
'@

$package = Get-AppxPackage -Name Mizan
if (!$package -or [string]$package.Version -ne $ExpectedVersion -or [string]$package.Status -ne 'Ok') {
    throw "The expected Mizan $ExpectedVersion package is not installed and healthy."
}
if (Get-Process -Name 'Mizan.Shell' -ErrorAction SilentlyContinue) {
    throw 'The cold-open check needs Mizan closed. No existing app was closed.'
}

function Wait-MidiDialog([string]$FileName) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $deadline) {
        $process = Get-Process -Name 'Mizan.Shell' -ErrorAction SilentlyContinue
        foreach ($app in $process) {
            $condition = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $app.Id)
            $window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
                [System.Windows.Automation.TreeScope]::Children, $condition)
            if (!$window) { continue }
            $nodes = $window.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition)
            $title = $null
            $cancel = $null
            $import = $null
            foreach ($node in $nodes) {
                $name = $node.Current.Name
                if ($name -like "*$FileName*") { $title = $name }
                if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
                    if ($name -eq 'Cancel') { $cancel = $node }
                    if ($name -eq 'Import') { $import = $node }
                }
            }
            if ($title -and $cancel -and $import) {
                $cancel.GetCurrentPattern(
                    [System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                return @{ processId = $app.Id; title = $title; cancelInvoked = $true; importOffered = $true }
            }
        }
        Start-Sleep -Milliseconds 300
    }
    throw "The installed native app did not show the explicit import dialog for $FileName."
}

$temp = Join-Path $PSScriptRoot ('native-midi-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
try {
    $appId = $package.PackageFamilyName + '!Mizan'
    $midi = [byte[]](0x4D,0x54,0x68,0x64,0,0,0,6,0,0,0,1,1,0xE0,
        0x4D,0x54,0x72,0x6B,0,0,0,0x0D,0,0x90,0x3C,0x40,
        0x83,0x60,0x80,0x3C,0,0,0xFF,0x2F,0)
    $results = @()
    foreach ($extension in @('mid', 'midi')) {
        $name = 'Mizan activation check.' + $extension
        $path = Join-Path $temp $name
        [IO.File]::WriteAllBytes($path, $midi)
        $activationId = [MizanVerification.Activation]::OpenFile($appId, $path)
        $result = Wait-MidiDialog $name
        $result.extension = $extension
        $result.activationProcessId = $activationId
        $results += $result
        Start-Sleep -Milliseconds 500
    }
    if ($results[0].processId -ne $results[1].processId) {
        throw 'Opening the second MIDI file did not reuse the existing native app.'
    }
    @{ version = $ExpectedVersion; appId = $appId; checks = $results; appLeftRunning = $true } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output -Encoding utf8
    Write-Output 'Native .mid cold-open and .midi running-open show explicit import; both cancelled; one app left running.'
}
finally {
    foreach ($name in @('Mizan activation check.mid', 'Mizan activation check.midi')) {
        $path = Join-Path $temp $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
    Remove-Item -LiteralPath $temp
}
