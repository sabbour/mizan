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
    private readonly WorkerProcess _worker = new();
    private readonly AppWindow _appWindow;
    private readonly SubclassProc _subclassProc;
    private readonly Grid _root = new();
    private readonly WebView2 _browser = new();
    private readonly Grid _errorPanel = new();
    private readonly TextBlock _errorMessage = new();
    private readonly Queue<string> _pendingMidiFiles = new();
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
            _browser.CoreWebView2.NavigationStarting += (_, _) => _webReady = false;
            _browser.CoreWebView2.NavigationCompleted += (_, _) =>
            {
                _webReady = true;
                while (_pendingMidiFiles.TryDequeue(out var message))
                    _browser.CoreWebView2.PostWebMessageAsJson(message);
            };

            var devUrl = Environment.GetEnvironmentVariable("MIZAN_DEV_URL");
            if (!string.IsNullOrWhiteSpace(devUrl))
            {
                _browser.Source = new Uri(devUrl);
                return;
            }

            var ui = FindUiDirectory();
            _browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "mizan.local", ui, CoreWebView2HostResourceAccessKind.DenyCors);
            _browser.Source = new Uri("https://mizan.local/index.html");
        }
        catch (Exception error)
        {
            ShowError(error.Message);
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
        RemoveWindowSubclass(WindowNative.GetWindowHandle(this), _subclassProc, SubclassId);
        await _worker.DisposeAsync();
    }

    private void CloseClicked(object sender, RoutedEventArgs e) => Close();

    private string PlacementPath
    {
        get
        {
            var directory = Environment.GetEnvironmentVariable("MIZAN_HOME");
            if (string.IsNullOrWhiteSpace(directory))
                directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizan");
            Directory.CreateDirectory(directory);
            return Path.Combine(directory, "window.json");
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
