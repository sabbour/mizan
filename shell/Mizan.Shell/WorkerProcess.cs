using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Mizan.Shell;

internal sealed class WorkerProcess : IAsyncDisposable
{
    private readonly HashSet<string> _pending = [];
    private readonly Lock _lock = new();
    private readonly SemaphoreSlim _inputLock = new(1, 1);
    private Process? _process;
    private bool _stopping;
    private int _restarts;

    public event Action<string>? MessageReceived;
    public event Action<string>? FatalError;

    public void Start() => StartProcess();

    public async Task SendAsync(string json)
    {
        using var document = JsonDocument.Parse(json);
        var id = document.RootElement.GetProperty("id").GetRawText();
        await _inputLock.WaitAsync();
        try
        {
            var process = _process;
            if (_stopping || process is null || process.HasExited)
                throw new InvalidOperationException("The Mizan worker is not running.");
            lock (_lock) _pending.Add(id);
            await process.StandardInput.WriteLineAsync(json);
            await process.StandardInput.FlushAsync();
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
            lock (_lock) _pending.Remove(id);
            AppendShellLog("Worker request failed.");
            SendError(id, "worker_unavailable", "The Mizan host is unavailable. Try again after it restarts.");
        }
        finally { _inputLock.Release(); }
    }

    private void StartProcess()
    {
        if (_stopping) return;
        var python = FindPython();
        var start = new ProcessStartInfo(python, "-m mizan.worker")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = AppContext.BaseDirectory,
        };
        start.Environment["PYTHONUTF8"] = "1";

        var packagedRoot = Path.Combine(AppContext.BaseDirectory, "Python");
        if (Directory.Exists(packagedRoot))
        {
            start.Environment["PYTHONHOME"] = packagedRoot;
        }
        else
        {
            var host = FindRepoDirectory("host");
            start.Environment["PYTHONPATH"] = host;
        }

        var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.Exited += (_, _) => _ = OnExitedAsync(process);
        _process = process;
        if (!process.Start()) throw new InvalidOperationException("Could not start the Mizan worker.");
        _ = ReadOutputAsync(process);
        _ = DrainErrorsAsync(process);
    }

    private async Task ReadOutputAsync(Process process)
    {
        while (await process.StandardOutput.ReadLineAsync() is { } line)
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                var id = document.RootElement.GetProperty("id").GetRawText();
                lock (_lock) _pending.Remove(id);
                MessageReceived?.Invoke(line);
            }
            catch (JsonException)
            {
                AppendShellLog("Worker wrote invalid JSON.");
            }
        }
    }

    private static async Task DrainErrorsAsync(Process process)
    {
        var errors = await process.StandardError.ReadToEndAsync();
        if (!string.IsNullOrWhiteSpace(errors)) AppendShellLog(errors);
    }

    private async Task OnExitedAsync(Process process)
    {
        if (_stopping || process != _process) return;
        FailPending("The Mizan host restarted unexpectedly.");
        if (_restarts++ == 0)
        {
            await Task.Delay(500);
            if (_stopping) return;
            try
            {
                StartProcess();
                return;
            }
            catch (Exception error)
            {
                AppendShellLog(error.ToString());
            }
        }
        FatalError?.Invoke("The background host stopped twice. Close Mizan, then start it again. Details are in %LOCALAPPDATA%\\Mizan\\logs\\mizan-shell.log.");
    }

    private void FailPending(string message)
    {
        string[] pending;
        lock (_lock)
        {
            pending = [.. _pending];
            _pending.Clear();
        }
        foreach (var id in pending)
            SendError(id, "worker_crashed", message);
    }

    private void SendError(string id, string code, string message)
    {
        MessageReceived?.Invoke(JsonSerializer.Serialize(new
        {
            id = JsonSerializer.Deserialize<JsonElement>(id),
            ok = false,
            error = new { code, message, fix = "Try again. If it keeps failing, restart Mizan." },
        }));
    }

    public async ValueTask DisposeAsync()
    {
        _stopping = true;
        var process = _process;
        if (process is null) return;
        try
        {
            process.StandardInput.Close();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
        }
        finally
        {
            process.Dispose();
        }
    }

    private static string FindPython()
    {
        var packaged = Path.Combine(AppContext.BaseDirectory, "Python", "python.exe");
        if (File.Exists(packaged)) return packaged;
        var host = FindRepoDirectory("host");
        var development = Path.Combine(host, ".venv", "Scripts", "python.exe");
        if (File.Exists(development)) return development;
        throw new FileNotFoundException("Python 3.12 was not found. Build the package or restore host\\.venv.", development);
    }

    private static string FindRepoDirectory(string name)
    {
        for (var directory = new DirectoryInfo(Environment.CurrentDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, name);
            if (Directory.Exists(candidate)) return candidate;
        }
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, name);
            if (Directory.Exists(candidate)) return candidate;
        }
        throw new DirectoryNotFoundException($"Could not locate the Mizan {name} directory.");
    }

    private static void AppendShellLog(string text)
    {
        ShellLog.Write(text.Trim());
    }
}
