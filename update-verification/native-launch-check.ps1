#Requires -Version 5.1
param(
    [string]$ExpectedVersion = '0.2.30.16',
    [string]$Output = (Join-Path $PSScriptRoot 'native-launch-runtime.json')
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') {
    & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -NoProfile -NonInteractive -File $PSCommandPath -ExpectedVersion $ExpectedVersion -Output $Output
    exit $LASTEXITCODE
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace MizanVerification {
    public static class NativeWindow {
        [StructLayout(LayoutKind.Sequential)]
        public struct Rect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
    }
}
'@

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition `
        -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1
} | Select-Object -First 1
if (!$asTask) { throw 'Windows asynchronous file APIs are unavailable.' }
function Wait-WindowsOperation($Operation, [Type]$ResultType) {
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}

$package = Get-AppxPackage -Name Mizan
if (!$package -or [string]$package.Version -ne $ExpectedVersion -or [string]$package.Status -ne 'Ok') {
    throw "The expected Mizan $ExpectedVersion package is not installed and healthy."
}
if (Get-Process -Name 'Mizan.Shell' -ErrorAction SilentlyContinue) {
    throw 'The cold-open check needs Mizan closed. No existing app was closed.'
}

function Read-WindowText($App) {
    $rect = New-Object MizanVerification.NativeWindow+Rect
    if (![MizanVerification.NativeWindow]::GetWindowRect($App.MainWindowHandle, [ref]$rect)) {
        throw 'Could not read the test app window bounds.'
    }
    $image = New-Object Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
    $graphics = [Drawing.Graphics]::FromImage($image)
    $dc = $graphics.GetHdc()
    try {
        if (![MizanVerification.NativeWindow]::PrintWindow($App.MainWindowHandle, $dc, 2)) {
            throw 'Could not capture the test app window.'
        }
    }
    finally {
        $graphics.ReleaseHdc($dc)
        $graphics.Dispose()
    }
    $path = Join-Path $temp 'window.png'
    try {
        $limit = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]::MaxImageDimension
        $scale = [Math]::Min(1, $limit / [Math]::Max($image.Width, $image.Height))
        $scaled = New-Object Drawing.Bitmap $image, ([int]($image.Width * $scale)), ([int]($image.Height * $scale))
        try { $scaled.Save($path, [Drawing.Imaging.ImageFormat]::Png) }
        finally { $scaled.Dispose() }
    }
    finally { $image.Dispose() }
    $file = Wait-WindowsOperation `
        ([Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]::GetFileFromPathAsync($path)) `
        ([Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime])
    $stream = Wait-WindowsOperation ($file.OpenReadAsync()) `
        ([Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime])
    try {
        $decoder = Wait-WindowsOperation `
            ([Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]::CreateAsync($stream)) `
            ([Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime])
        $bitmap = Wait-WindowsOperation ($decoder.GetSoftwareBitmapAsync()) `
            ([Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime])
        try {
            $engine = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]::TryCreateFromUserProfileLanguages()
            if (!$engine) { throw 'Windows text recognition is unavailable for the current languages.' }
            $result = Wait-WindowsOperation ($engine.RecognizeAsync($bitmap)) `
                ([Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime])
            return $result.Text -replace '\s+', ' '
        }
        finally { $bitmap.Dispose() }
    }
    finally { $stream.Dispose() }
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
            if ($app.MainWindowHandle -ne [IntPtr]::Zero) {
                $text = Read-WindowText $app
                if ($text -match [Regex]::Escape($FileName) -and $text -match '\bCancel\b' `
                        -and [Regex]::Matches($text, '\bImport\b').Count -ge 2) {
                    [MizanVerification.NativeWindow]::SetForegroundWindow($app.MainWindowHandle) | Out-Null
                    if ([MizanVerification.NativeWindow]::GetForegroundWindow() -ne $app.MainWindowHandle) {
                        throw 'The test app is not in the foreground; no key was sent.'
                    }
                    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
                    Start-Sleep -Milliseconds 500
                    if ((Read-WindowText $app) -match [Regex]::Escape($FileName)) {
                        throw 'The native MIDI import prompt did not close after Escape.'
                    }
                    return @{ processId = $app.Id; title = $FileName; cancelInvoked = $true
                        importOffered = $true; visibleTextVerified = $true }
                }
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
        $file = Wait-WindowsOperation `
            ([Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]::GetFileFromPathAsync($path)) `
            ([Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime])
        $options = [Windows.System.LauncherOptions, Windows.System, ContentType=WindowsRuntime]::new()
        $options.TargetApplicationPackageFamilyName = $package.PackageFamilyName
        $launched = Wait-WindowsOperation `
            ([Windows.System.Launcher, Windows.System, ContentType=WindowsRuntime]::LaunchFileAsync($file, $options)) `
            ([bool])
        if (!$launched) { throw "Windows rejected Mizan's registered file activation for $name." }
        $result = Wait-MidiDialog $name
        $result.extension = $extension
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
    foreach ($name in @('Mizan activation check.mid', 'Mizan activation check.midi', 'window.png')) {
        $path = Join-Path $temp $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
    Remove-Item -LiteralPath $temp
}
