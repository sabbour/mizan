using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Mizan.Shell;

public partial class App : Application
{
    private MainWindow? _window;

    [DllImport("user32.dll")]
    private static extern bool IsIconic(nint hwnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(nint hwnd, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hwnd);

    public App()
    {
        ShellLog.Write("App constructing.");
        InitializeComponent();
        UnhandledException += (_, error) => ShellLog.Write("Unhandled XAML exception: " + error.Message);
        AppDomain.CurrentDomain.UnhandledException += (_, error) =>
            ShellLog.Write("Unhandled runtime exception: " + error.ExceptionObject);
        ShellLog.Write("App initialized.");
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            ShellLog.Write("Launch started.");
            if (Environment.GetEnvironmentVariable("MIZAN_ALLOW_MULTIPLE") != "1")
            {
                var current = AppInstance.GetCurrent();
                var main = AppInstance.FindOrRegisterForKey("mizan-single-instance");
                if (!main.IsCurrent)
                {
                    ShellLog.Write("Redirecting activation to the main instance.");
                    await main.RedirectActivationToAsync(current.GetActivatedEventArgs());
                    using var process = Process.GetProcessById((int)main.ProcessId);
                    var hwnd = process.MainWindowHandle;
                    if (hwnd != 0 && IsIconic(hwnd)) ShowWindow(hwnd, 9);
                    if (hwnd == 0 || !SetForegroundWindow(hwnd))
                        ShellLog.Write("Could not bring the existing window to the foreground.");
                    Exit();
                    return;
                }
                main.Activated += (_, _) => _window?.DispatcherQueue.TryEnqueue(() => _window.Activate());
            }

            _window = new MainWindow();
            _window.Activate();
            ShellLog.Write("Main window activated.");
        }
        catch (Exception error)
        {
            ShellLog.Write("Launch failed: " + error);
            Exit();
        }
    }
}
