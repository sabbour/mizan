using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using WinRT.Interop;

namespace Mizan.Shell;

internal sealed class YouTubeSignInWindow : Window
{
    private const string SignInUrl =
        "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/";
    private const int MinWidth = 800;
    private const int MinHeight = 560;
    private const int WmGetMinMaxInfo = 0x0024;
    private const nuint SubclassId = 2;
    private static readonly string[] CookieUrls =
    [
        "https://www.youtube.com",
        "https://youtube.com",
        "https://accounts.google.com",
        "https://google.com",
    ];

    private readonly string _dataDirectory;
    private readonly WebView2 _browser = new();
    private readonly TextBlock _status = new()
    {
        Text = "Sign in here. This window closes when your session is saved.",
        TextWrapping = TextWrapping.Wrap,
    };
    private readonly TaskCompletionSource<bool> _completion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim _sessionCheckGate = new(1, 1);
    private readonly SubclassProc _subclassProc;

    public YouTubeSignInWindow(string dataDirectory)
    {
        _dataDirectory = dataDirectory;
        Title = "Sign in to YouTube — Mizan";

        var layout = new Grid();
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        layout.Children.Add(new Border
        {
            Padding = new Thickness(16, 10, 16, 10),
            Child = new StackPanel
            {
                Spacing = 4,
                Children =
                {
                    new TextBlock
                    {
                        Text = "Sign in to YouTube",
                        FontSize = 18,
                        FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
                    },
                    _status,
                },
            },
        });
        _browser.HorizontalAlignment = HorizontalAlignment.Stretch;
        _browser.VerticalAlignment = VerticalAlignment.Stretch;
        Grid.SetRow(_browser, 1);
        layout.Children.Add(_browser);
        Content = layout;

        var hwnd = WindowNative.GetWindowHandle(this);
        _subclassProc = WindowSubclass;
        SetWindowSubclass(hwnd, _subclassProc, SubclassId, 0);
        Closed += (_, _) =>
        {
            RemoveWindowSubclass(hwnd, _subclassProc, SubclassId);
            if (!_completion.Task.IsCompleted)
                _completion.TrySetResult(false);
        };

        var appWindow = AppWindow.GetFromWindowId(Win32Interop.GetWindowIdFromWindow(hwnd));
        appWindow.Resize(new Windows.Graphics.SizeInt32(1000, 760));
        _ = InitializeAsync();
    }

    public Task<bool> Completion => _completion.Task;

    public void Cancel() => Close();

    public static async Task ClearProfileCookiesAsync(string dataDirectory, nint parentWindow)
    {
        var profile = ProfileDirectory(dataDirectory);
        Directory.CreateDirectory(profile);
        var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
            null, profile, new CoreWebView2EnvironmentOptions());
        CoreWebView2Controller? controller = null;
        try
        {
            var windowReference = CoreWebView2ControllerWindowReference.CreateFromWindowHandle(
                unchecked((ulong)parentWindow));
            controller = await environment.CreateCoreWebView2ControllerAsync(windowReference);
            controller.CoreWebView2.CookieManager.DeleteAllCookies();
        }
        finally
        {
            controller?.Close();
        }
    }

    public static async Task RefreshSavedSessionAsync(
        string dataDirectory, nint parentWindow, CancellationToken cancellationToken)
    {
        CoreWebView2Controller? controller = null;
        try
        {
            if (!HasSavedAppSession(dataDirectory))
                return;

            var profile = ProfileDirectory(dataDirectory);
            var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
                null, profile, new CoreWebView2EnvironmentOptions());
            cancellationToken.ThrowIfCancellationRequested();

            var windowReference = CoreWebView2ControllerWindowReference.CreateFromWindowHandle(
                unchecked((ulong)parentWindow));
            controller = await environment.CreateCoreWebView2ControllerAsync(windowReference);
            controller.IsVisible = false;

            var coreWebView2 = controller.CoreWebView2;
            var navigationCompleted = new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args) =>
                navigationCompleted.TrySetResult(args.IsSuccess);

            coreWebView2.NavigationCompleted += OnNavigationCompleted;
            try
            {
                coreWebView2.Navigate("https://www.youtube.com/");
                try
                {
                    var navigationSucceeded = await navigationCompleted.Task.WaitAsync(
                        TimeSpan.FromSeconds(20), cancellationToken);
                    if (!navigationSucceeded)
                        ShellLog.Write("YouTube cookie refresh navigation did not complete successfully; checking the saved session.");
                }
                catch (TimeoutException)
                {
                    ShellLog.Write("YouTube cookie refresh navigation timed out; checking the saved session.");
                }
            }
            finally
            {
                coreWebView2.NavigationCompleted -= OnNavigationCompleted;
            }

            cancellationToken.ThrowIfCancellationRequested();
            if (!HasSavedAppSession(dataDirectory))
                return;

            var cookies = await GetSupportedCookiesAsync(coreWebView2);
            cancellationToken.ThrowIfCancellationRequested();
            if (!HasAuthenticatedYoutubeSession(cookies))
            {
                ShellLog.Write("The saved YouTube app session is no longer authenticated; keeping the existing cookie file.");
                return;
            }
            if (!HasSavedAppSession(dataDirectory))
                return;

            SaveCookies(dataDirectory, cookies);
            ShellLog.Write("Refreshed saved YouTube sign-in cookies.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            ShellLog.Write($"Could not refresh saved YouTube sign-in cookies: {error.Message}");
        }
        finally
        {
            try
            {
                controller?.Close();
            }
            catch (Exception error)
            {
                ShellLog.Write($"Could not close the YouTube cookie refresh controller: {error.Message}");
            }
        }
    }

    private async Task InitializeAsync()
    {
        try
        {
            var profile = ProfileDirectory(_dataDirectory);
            Directory.CreateDirectory(profile);
            var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
                null, profile, new CoreWebView2EnvironmentOptions());
            await _browser.EnsureCoreWebView2Async(environment);
            _browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _browser.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var target)
                    && target.Scheme is "http" or "https")
                    _browser.CoreWebView2.Navigate(target.AbsoluteUri);
            };
            _browser.CoreWebView2.NavigationCompleted += (_, _) => _ = CheckAndSaveSessionAsync();
            _browser.Source = new Uri(SignInUrl);
            _ = MonitorSignInAsync();
        }
        catch (Exception error)
        {
            ShellLog.Write($"Could not initialize the YouTube sign-in window: {error.Message}");
            _status.Text = "The sign-in window could not start. Close it and try again.";
        }
    }

    private async Task MonitorSignInAsync()
    {
        while (!_completion.Task.IsCompleted)
        {
            await Task.Delay(TimeSpan.FromSeconds(1));
            if (!_completion.Task.IsCompleted)
                await CheckAndSaveSessionAsync();
        }
    }

    private async Task CheckAndSaveSessionAsync()
    {
        if (_completion.Task.IsCompleted || _browser.CoreWebView2 is null
            || !await _sessionCheckGate.WaitAsync(0))
            return;
        try
        {
            if (_completion.Task.IsCompleted)
                return;

            var cookies = await GetSupportedCookiesAsync(_browser.CoreWebView2);
            if (_completion.Task.IsCompleted)
                return;
            if (!HasAuthenticatedYoutubeSession(cookies))
                return;

            _status.Text = "Saving your YouTube sign-in…";
            if (_completion.Task.IsCompleted)
                return;
            SaveCookies(_dataDirectory, cookies);
            _status.Text = "YouTube sign-in saved.";
            if (_completion.TrySetResult(true))
                Close();
        }
        catch (Exception error)
        {
            ShellLog.Write($"Could not save YouTube sign-in cookies: {error.Message}");
            _status.Text = "Mizan could not save your sign-in. Close this window and try again.";
        }
        finally
        {
            _sessionCheckGate.Release();
        }
    }

    private static async Task<IReadOnlyCollection<CoreWebView2Cookie>> GetSupportedCookiesAsync(
        CoreWebView2 coreWebView2)
    {
        var cookies = new Dictionary<string, CoreWebView2Cookie>(StringComparer.Ordinal);
        foreach (var url in CookieUrls)
        {
            foreach (var cookie in await coreWebView2.CookieManager.GetCookiesAsync(url))
            {
                if (!IsSupportedCookieDomain(cookie.Domain))
                    continue;
                var key = $"{cookie.Domain}\n{cookie.Path}\n{cookie.Name}";
                cookies[key] = cookie;
            }
        }
        return cookies.Values.ToArray();
    }

    private static bool HasSavedAppSession(string dataDirectory) =>
        Directory.Exists(ProfileDirectory(dataDirectory))
        && File.Exists(Path.Combine(dataDirectory, "youtube-cookies-source.txt"))
        && string.Equals(
            File.ReadAllText(Path.Combine(dataDirectory, "youtube-cookies-source.txt")).Trim(),
            "app",
            StringComparison.Ordinal);

    private static void SaveCookies(string dataDirectory, IEnumerable<CoreWebView2Cookie> cookies)
    {
        var lines = new List<string>
        {
            "# Netscape HTTP Cookie File",
            "# Saved by Mizan. Keep this file private.",
        };
        foreach (var cookie in cookies)
        {
            var domain = cookie.Domain;
            if (string.IsNullOrWhiteSpace(domain) || string.IsNullOrWhiteSpace(cookie.Name)
                || string.IsNullOrWhiteSpace(cookie.Path) || !cookie.Path.StartsWith("/", StringComparison.Ordinal)
                || new[] { domain, cookie.Path, cookie.Name, cookie.Value }
                    .Any(value => value?.IndexOfAny(['\t', '\r', '\n']) >= 0))
                continue;

            var expiry = cookie.IsSession
                ? "0"
                : Math.Max(0, (long)cookie.Expires).ToString(CultureInfo.InvariantCulture);
            var secure = cookie.IsSecure ? "TRUE" : "FALSE";
            var include = domain.StartsWith(".", StringComparison.Ordinal) ? "TRUE" : "FALSE";
            var prefix = cookie.IsHttpOnly ? "#HttpOnly_" : "";
            lines.Add($"{prefix}{domain}\t{include}\t{cookie.Path}\t{secure}\t{expiry}\t{cookie.Name}\t{cookie.Value}");
        }
        if (lines.Count == 2)
            throw new InvalidOperationException("YouTube did not provide cookies to save.");

        Directory.CreateDirectory(dataDirectory);
        var cookiePath = Path.Combine(dataDirectory, "youtube-cookies.txt");
        var sourcePath = Path.Combine(dataDirectory, "youtube-cookies-source.txt");
        var suffix = $".{Guid.NewGuid():N}.tmp";
        var cookieTemp = cookiePath + suffix;
        var sourceTemp = sourcePath + suffix;
        try
        {
            File.WriteAllLines(cookieTemp, lines);
            File.WriteAllText(sourceTemp, "app\n");
            File.Move(cookieTemp, cookiePath, true);
            File.Move(sourceTemp, sourcePath, true);
        }
        finally
        {
            if (File.Exists(cookieTemp)) File.Delete(cookieTemp);
            if (File.Exists(sourceTemp)) File.Delete(sourceTemp);
        }
    }

    private static bool HasAuthenticatedYoutubeSession(IEnumerable<CoreWebView2Cookie> cookies)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        return cookies.Any(cookie =>
            IsYoutubeDomain(cookie.Domain)
            && cookie.Name is "SAPISID" or "__Secure-3PAPISID"
            && !string.IsNullOrWhiteSpace(cookie.Value)
            && (cookie.IsSession || cookie.Expires > now));
    }

    private nint WindowSubclass(nint hwnd, uint message, nuint wParam, nint lParam, nuint id, nuint data)
    {
        if (message == WmGetMinMaxInfo)
        {
            var info = Marshal.PtrToStructure<MinMaxInfo>(lParam);
            info.MinTrackSize.X = MinWidth;
            info.MinTrackSize.Y = MinHeight;
            Marshal.StructureToPtr(info, lParam, false);
        }
        return DefSubclassProc(hwnd, message, wParam, lParam);
    }

    private static string ProfileDirectory(string dataDirectory) =>
        Path.Combine(dataDirectory, "youtube-signin-webview");

    private static bool IsYoutubeDomain(string domain)
    {
        var normalized = domain.TrimStart('.').ToLowerInvariant();
        return normalized == "youtube.com" || normalized.EndsWith(".youtube.com", StringComparison.Ordinal);
    }

    private static bool IsSupportedCookieDomain(string domain)
    {
        var normalized = domain.TrimStart('.').ToLowerInvariant();
        return IsYoutubeDomain(domain) || normalized == "google.com"
            || normalized.EndsWith(".google.com", StringComparison.Ordinal);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point Reserved;
        public Point MaxSize;
        public Point MaxPosition;
        public Point MinTrackSize;
        public Point MaxTrackSize;
    }

    private delegate nint SubclassProc(nint hwnd, uint message, nuint wParam, nint lParam, nuint id, nuint data);

    [DllImport("comctl32.dll")]
    private static extern bool SetWindowSubclass(nint hwnd, SubclassProc callback, nuint id, nuint data);

    [DllImport("comctl32.dll")]
    private static extern bool RemoveWindowSubclass(nint hwnd, SubclassProc callback, nuint id);

    [DllImport("comctl32.dll")]
    private static extern nint DefSubclassProc(nint hwnd, uint message, nuint wParam, nint lParam);
}
