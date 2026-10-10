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
                var activation = current.GetActivatedEventArgs();
                if (!main.IsCurrent)
                {
                    ShellLog.Write("Redirecting activation to the main instance.");
                    await main.RedirectActivationToAsync(activation);
                    using var process = Process.GetProcessById((int)main.ProcessId);
                    var hwnd = process.MainWindowHandle;
                    if (hwnd != 0 && IsIconic(hwnd)) ShowWindow(hwnd, 9);
                    if (hwnd == 0 || !SetForegroundWindow(hwnd))
                        ShellLog.Write("Could not bring the existing window to the foreground.");
                    Exit();
                    return;
                }
                var pendingActivations = new Queue<AppActivationArguments>();
                var activationLock = new Lock();
                main.Activated += (_, redirected) =>
                {
                    MainWindow? window;
                    lock (activationLock)
                    {
                        window = _window;
                        if (window is null)
                        {
                            pendingActivations.Enqueue(redirected);
                            return;
                        }
                    }
                    window.DispatcherQueue.TryEnqueue(() =>
                    {
                        window.Activate();
                        _ = window.HandleActivationAsync(redirected);
                    });
                };

                var createdWindow = new MainWindow();
                AppActivationArguments[] queued;
                lock (activationLock)
                {
                    _window = createdWindow;
                    queued = pendingActivations.ToArray();
                    pendingActivations.Clear();
                }
                createdWindow.Activate();
                _ = createdWindow.HandleActivationAsync(activation);
                foreach (var redirected in queued) _ = createdWindow.HandleActivationAsync(redirected);
                ShellLog.Write("Main window activated.");
                return;
            }

            _window = new MainWindow();
            _window.Activate();
            _ = _window.HandleActivationAsync(AppInstance.GetCurrent().GetActivatedEventArgs());
            ShellLog.Write("Main window activated.");
        }
        catch (Exception error)
        {
            ShellLog.Write("Launch failed: " + error);
            Exit();
        }
    }
}
