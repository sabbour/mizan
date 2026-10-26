namespace Mizan.Shell;

internal static class ShellLog
{
    public static List<string> Messages { get; } = [];

    public static void Write(string message) => Messages.Add(message);
}
