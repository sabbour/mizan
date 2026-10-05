namespace Mizan.Shell;

internal static class ShellLog
{
    private static readonly string Path = BuildPath();

    public static void Write(string message)
    {
        try
        {
            File.AppendAllText(Path, $"{DateTimeOffset.Now:u} {message}{Environment.NewLine}");
        }
        catch
        {
        }
    }

    private static string BuildPath()
    {
        var directory = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizan", "logs");
        Directory.CreateDirectory(directory);
        return System.IO.Path.Combine(directory, "mizan-shell.log");
    }
}
