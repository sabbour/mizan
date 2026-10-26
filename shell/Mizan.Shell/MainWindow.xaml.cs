using System.Runtime.InteropServices;
using System.Text.Json;
using System.IO;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Windows.AppLifecycle;
using Microsoft.Windows.Storage.Pickers;
using Windows.UI;
using WinRT.Interop;
using Windows.ApplicationModel.Activation;
using Windows.Storage;

namespace Mizan.Shell;

public sealed class MainWindow : Window
{
    private const int MinWidth = 1024;
    private const int MinHeight = 640;
    private const uint WmGetMinMaxInfo = 0x0024;
    private const int SubclassId = 1;
    private readonly WorkerProcess _worker = new(WorkerDataDirectory);
    private readonly AppWindow _appWindow;
    private readonly SubclassProc _subclassProc;
    private readonly Grid _root = new();
    private readonly WebView2 _browser = new();
    private readonly Grid _errorPanel = new();
    private readonly TextBlock _errorMessage = new();
    private readonly Queue<string> _pendingMidiFiles = new();
    private Uri _appOrigin = new("https://mizan.local");
    private YouTubeSignInWindow? _youtubeSignInWindow;
    private readonly CancellationTokenSource _youtubeRefreshCancellation = new();
    private Task? _youtubeRefreshTask;
    private bool _webReady;

    public MainWindow()
    {
        ShellLog.Write("Main window constructing.");
        Content = _root;
        BuildContent();
        Title = "Mizan";
        SystemBackdrop = new MicaBackdrop();

        var hwnd = WindowNative.GetWindowHandle(this);
        _appWindow = AppWindow.GetFromWindowId(Win32Interop.GetWindowIdFromWindow(hwnd));
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "Mizan.ico");
        if (File.Exists(icon)) _appWindow.SetIcon(icon);
        RestorePlacement();

        _subclassProc = WindowSubclass;
        SetWindowSubclass(hwnd, _subclassProc, SubclassId, 0);
        _appWindow.Closing += (_, _) => SavePlacement();
        Closed += OnClosed;

        _worker.MessageReceived += message => DispatcherQueue.TryEnqueue(
            () => _browser.CoreWebView2?.PostWebMessageAsJson(message));
        _worker.FatalError += message => DispatcherQueue.TryEnqueue(() => ShowError(message));
        _ = InitializeAsync();
        ShellLog.Write("Main window constructed.");
    }

    private async Task InitializeAsync()
    {
        try
        {
            _worker.Start();
            await _browser.EnsureCoreWebView2Async();
            await _browser.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.__mizanNativeShell = true;");
            _browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _browser.CoreWebView2.WebMessageReceived += async (_, args) =>
            {
                try
                {
                    using var request = JsonDocument.Parse(args.WebMessageAsJson);
                    var root = request.RootElement;
                    if (TryGetShellRequest(root, "youtube_sign_in", out var signInId))
                    {
                        YouTubeSignInWindow? signInWindow = null;
                        try
                        {
                            signInWindow = _youtubeSignInWindow ??= new YouTubeSignInWindow(DataDirectory);
                            signInWindow.Activate();
                            var signedIn = await signInWindow.Completion;
                            _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
                            {
                                id = signInId,
                                ok = true,
                                result = new { ok = true, signedIn },
                            }));
                        }
                        catch (Exception error)
                        {
                            ShellLog.Write($"YouTube sign-in failed: {error.Message}");
                            PostBridgeError(signInId, "youtube_sign_in_failed",
                                "The YouTube sign-in window could not open. Try again.");
                        }
                        finally
                        {
                            if (signInWindow is not null && ReferenceEquals(_youtubeSignInWindow, signInWindow))
                                _youtubeSignInWindow = null;
                        }
                        return;
                    }
                    if (TryGetShellRequest(root, "youtube_sign_out", out var signOutId))
                    {
                        try
                        {
                            _youtubeRefreshCancellation.Cancel();
                            if (_youtubeRefreshTask is not null)
                                await _youtubeRefreshTask;
                            _youtubeSignInWindow?.Cancel();
                            _youtubeSignInWindow = null;
                            File.Delete(Path.Combine(DataDirectory, "youtube-cookies.txt"));
                            File.Delete(Path.Combine(DataDirectory, "youtube-cookies-source.txt"));
                            await YouTubeSignInWindow.ClearProfileCookiesAsync(
                                DataDirectory, WindowNative.GetWindowHandle(this));
                            _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
                            {
                                id = signOutId,
                                ok = true,
                                result = new { ok = true, signedIn = false, source = (string?)null },
                            }));
                        }
                        catch (Exception error)
                        {
                            ShellLog.Write($"YouTube sign-out failed: {error.Message}");
                            PostBridgeError(signOutId, "youtube_sign_out_failed",
                                "Mizan could not clear the YouTube sign-in. Try again.");
                        }
                        return;
                    }
                    if (TryGetShellRequest(root, "browse_youtube_cookies", out var browseCookiesId))
                    {
                        await BrowseYoutubeCookiesAsync(browseCookiesId);
                        return;
                    }
                    if (TryGetShellRequest(root, "github_release_update_check", out var releaseCheckId))
                    {
                        try
                        {
                            PostReleaseUpdateCheck(releaseCheckId, await ReleaseUpdateChecker.CheckAsync());
                        }
                        catch (Exception error)
                        {
                            ShellLog.Write($"GitHub release check failed unexpectedly: {error.Message}");
                            PostReleaseUpdateCheck(releaseCheckId, new(
                                "unavailable", null, null, null,
                                "GitHub Releases could not be checked. Try again later."));
                        }
                        return;
                    }
                    if (root.ValueKind == JsonValueKind.Object
                        && root.TryGetProperty("method", out var method)
                        && method.ValueKind == JsonValueKind.String
                        && method.GetString() == "browse_ffmpeg_path"
                        && root.TryGetProperty("args", out var requestArgs)
                        && requestArgs.ValueKind == JsonValueKind.Array
                        && requestArgs.GetArrayLength() == 0
                        && root.TryGetProperty("id", out var id)
                        && id.ValueKind == JsonValueKind.Number
                        && id.TryGetInt32(out var requestId))
                    {
                        await BrowseFfmpegPathAsync(requestId);
                        return;
                    }
                    await _worker.SendAsync(args.WebMessageAsJson);
                }
                catch (Exception)
                {
                    ShowError("Could not send a request to Mizan's background host.");
                }
            };
            _browser.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (!IsAppUri(args.Uri))
                    OpenExternally(args.Uri);
            };
            _browser.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!IsAppUri(args.Uri))
                {
                    args.Cancel = true;
                    OpenExternally(args.Uri);
                    return;
                }
                _webReady = false;
            };
            _browser.CoreWebView2.NavigationCompleted += (_, _) =>
            {
                _webReady = true;
                while (_pendingMidiFiles.TryDequeue(out var message))
                    _browser.CoreWebView2.PostWebMessageAsJson(message);
            };

            var devUrl = Environment.GetEnvironmentVariable("MIZAN_DEV_URL");
            if (!string.IsNullOrWhiteSpace(devUrl))
            {
                var dev = new Uri(devUrl);
                _appOrigin = new Uri(dev.GetLeftPart(UriPartial.Authority));
                _browser.Source = dev;
                StartYoutubeSessionRefresh();
                return;
            }

            var ui = FindUiDirectory();
            _browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "mizan.local", ui, CoreWebView2HostResourceAccessKind.DenyCors);
            _browser.Source = new Uri("https://mizan.local/index.html");
            StartYoutubeSessionRefresh();
        }
        catch (Exception error)
        {
            ShowError(error.Message);
        }
    }

    private void StartYoutubeSessionRefresh() =>
        _youtubeRefreshTask ??= YouTubeSignInWindow.RefreshSavedSessionAsync(
            DataDirectory, WindowNative.GetWindowHandle(this), _youtubeRefreshCancellation.Token);

    private bool IsAppUri(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var target)) return false;
        if (target.AbsoluteUri == "about:blank") return true;
        return string.Equals(target.Scheme, _appOrigin.Scheme, StringComparison.OrdinalIgnoreCase)
            && string.Equals(target.IdnHost, _appOrigin.IdnHost, StringComparison.OrdinalIgnoreCase)
            && target.Port == _appOrigin.Port;
    }

    private static void OpenExternally(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var target)
            || target.Scheme is not ("http" or "https"))
        {
            ShellLog.Write($"Blocked a non-web link: {uri}");
            return;
        }
        _ = Windows.System.Launcher.LaunchUriAsync(target);
    }

    private static bool TryGetShellRequest(JsonElement root, string methodName, out int requestId)
    {
        requestId = 0;
        return root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("method", out var method)
            && method.ValueKind == JsonValueKind.String
            && method.GetString() == methodName
            && root.TryGetProperty("args", out var requestArgs)
            && requestArgs.ValueKind == JsonValueKind.Array
            && requestArgs.GetArrayLength() == 0
            && root.TryGetProperty("id", out var id)
            && id.ValueKind == JsonValueKind.Number
            && id.TryGetInt32(out requestId);
    }

    private void PostBridgeError(int id, string code, string message) =>
        _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            id,
            ok = false,
            error = new { code, message },
        }));

    private void PostReleaseUpdateCheck(int id, ReleaseUpdateCheckResult result) =>
        _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            id,
            ok = true,
            result = new
            {
                ok = true,
                status = result.Status,
                currentVersion = result.CurrentVersion,
                architecture = result.Architecture,
                releasePayload = result.ReleasePayload,
                message = result.Message,
            },
        }));

    private async Task BrowseYoutubeCookiesAsync(int id)
    {
        try
        {
            var picker = new FileOpenPicker(_appWindow.Id);
            picker.FileTypeFilter.Add(".txt");
            picker.CommitButtonText = "Select cookies.txt";
            var file = await picker.PickSingleFileAsync();
            _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                id,
                ok = true,
                result = new { ok = true, path = file?.Path },
            }));
        }
        catch (Exception error)
        {
            ShellLog.Write($"YouTube cookies file picker failed: {error.Message}");
            PostBridgeError(id, "youtube_cookies_picker_failed",
                "Could not open the file picker. Enter the full path to cookies.txt instead.");
        }
    }

    private async Task BrowseFfmpegPathAsync(int id)
    {
        try
        {
            var picker = new FileOpenPicker(_appWindow.Id);
            picker.FileTypeFilter.Add(".exe");
            picker.CommitButtonText = "Select FFmpeg";
            var file = await picker.PickSingleFileAsync();
            _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                id,
                ok = true,
                result = new { ok = true, path = file?.Path },
            }));
        }
        catch (Exception error)
        {
            ShellLog.Write($"FFmpeg file picker failed: {error.Message}");
            _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                id,
                ok = false,
                error = new
                {
                    code = "native_picker_unavailable",
                    message = "Could not open the Windows file picker. Enter the full path to ffmpeg.exe instead.",
                    fix = "Enter the full path to ffmpeg.exe instead.",
                },
            }));
        }
    }

    public async Task HandleActivationAsync(AppActivationArguments activation)
    {
        if (activation.Kind != ExtendedActivationKind.File || activation.Data is not IFileActivatedEventArgs files)
            return;
        foreach (var item in files.Files)
        {
            if (item is not StorageFile file || !Path.GetExtension(file.Name).Equals(".mid", StringComparison.OrdinalIgnoreCase)
                && !Path.GetExtension(file.Name).Equals(".midi", StringComparison.OrdinalIgnoreCase))
                continue;
            try
            {
                await using var input = await file.OpenStreamForReadAsync();
                using var content = new MemoryStream();
                await input.CopyToAsync(content);
                var message = JsonSerializer.Serialize(new
                {
                    type = "mizan-open-midi",
                    name = file.Name,
                    dataBase64 = Convert.ToBase64String(content.ToArray()),
                });
                if (_webReady) _browser.CoreWebView2.PostWebMessageAsJson(message);
                else _pendingMidiFiles.Enqueue(message);
            }
            catch (Exception error)
            {
                ShellLog.Write($"Could not open MIDI activation '{file.Name}': {error.Message}");
            }
        }
    }

    private static string FindUiDirectory()
    {
        var packaged = Path.Combine(AppContext.BaseDirectory, "ui", "dist");
        if (File.Exists(Path.Combine(packaged, "index.html"))) return packaged;
        for (var directory = new DirectoryInfo(Environment.CurrentDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "ui", "dist");
            if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
        }
        throw new FileNotFoundException("The built UI was not found. Run 'cd ui; npm run build' or set MIZAN_DEV_URL.");
    }

    private void ShowError(string message)
    {
        ShellLog.Write("Native error: " + message);
        _errorMessage.Text = message;
        _errorPanel.Visibility = Visibility.Visible;
    }

    private void BuildContent()
    {
        _root.Children.Add(_browser);
        _errorPanel.RequestedTheme = ElementTheme.Light;
        _errorPanel.Background = new SolidColorBrush(Color.FromArgb(255, 247, 243, 235));
        _errorPanel.Visibility = Visibility.Collapsed;
        var content = new StackPanel
        {
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            MaxWidth = 560,
            Spacing = 12,
        };
        content.Children.Add(new TextBlock
        {
            Text = "Mizan could not start",
            FontSize = 28,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
        });
        _errorMessage.TextWrapping = TextWrapping.Wrap;
        _errorMessage.FontSize = 16;
        content.Children.Add(_errorMessage);
        var close = new Button { Content = "Close Mizan", HorizontalAlignment = HorizontalAlignment.Left };
        close.Click += CloseClicked;
        content.Children.Add(close);
        _errorPanel.Children.Add(content);
        _root.Children.Add(_errorPanel);
    }

    private async void OnClosed(object sender, WindowEventArgs args)
    {
        _youtubeRefreshCancellation.Cancel();
        _youtubeSignInWindow?.Cancel();
        RemoveWindowSubclass(WindowNative.GetWindowHandle(this), _subclassProc, SubclassId);
        if (_youtubeRefreshTask is not null)
            await _youtubeRefreshTask;
        _youtubeRefreshCancellation.Dispose();
        await _worker.DisposeAsync();
    }

    private void CloseClicked(object sender, RoutedEventArgs e) => Close();

    private string PlacementPath
    {
        get
        {
            return Path.Combine(DataDirectory, "window.json");
        }
    }

    private static string DataDirectory
    {
        get
        {
            var directory = Environment.GetEnvironmentVariable("MIZAN_HOME");
            if (string.IsNullOrWhiteSpace(directory))
                directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizan");
            Directory.CreateDirectory(directory);
            return directory;
        }
    }

    private static string WorkerDataDirectory
    {
        get
        {
            var configured = Environment.GetEnvironmentVariable("MIZAN_HOME");
            if (!string.IsNullOrWhiteSpace(configured))
                return configured;

            var windowsApps = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps")
                + Path.DirectorySeparatorChar;
            if (AppContext.BaseDirectory.StartsWith(windowsApps, StringComparison.OrdinalIgnoreCase))
                return Path.Combine(ApplicationData.Current.LocalCacheFolder.Path, "Local", "Mizan");

            return DataDirectory;
        }
    }

    private void RestorePlacement()
    {
        try
        {
            var saved = JsonSerializer.Deserialize<Placement>(File.ReadAllText(PlacementPath));
            if (saved is null) return;
            var placement = saved with
            {
                Width = Math.Max(MinWidth, saved.Width),
                Height = Math.Max(MinHeight, saved.Height)
            };
            if (!OnScreen(placement))
            {
                ShellLog.Write("Ignoring saved window placement outside active displays.");
                return;
            }
            _appWindow.MoveAndResize(new Windows.Graphics.RectInt32(
                placement.X, placement.Y, placement.Width, placement.Height));
        }
        catch (IOException) { }
        catch (JsonException) { }
    }

    private void SavePlacement()
    {
        if (IsIconic(WindowNative.GetWindowHandle(this))) return;
        var position = _appWindow.Position;
        var size = _appWindow.Size;
        var placement = new Placement(position.X, position.Y, size.Width, size.Height);
        if (OnScreen(placement))
            File.WriteAllText(PlacementPath, JsonSerializer.Serialize(placement));
    }

    private static bool OnScreen(Placement placement)
    {
        var rect = new Rect
        {
            Left = placement.X, Top = placement.Y,
            Right = placement.X + placement.Width, Bottom = placement.Y + placement.Height
        };
        return MonitorFromRect(in rect, 0) != 0;
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

    private sealed record Placement(int X, int Y, int Width, int Height);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

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

    [DllImport("user32.dll")]
    private static extern bool IsIconic(nint hwnd);

    [DllImport("user32.dll")]
    private static extern nint MonitorFromRect(in Rect rect, uint flags);
}
