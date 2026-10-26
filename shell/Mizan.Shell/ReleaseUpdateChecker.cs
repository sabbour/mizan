using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text.Json.Serialization;
using System.Text;
using Windows.ApplicationModel;
using Windows.System;

namespace Mizan.Shell;

internal sealed record ReleaseUpdateCheckResult(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("currentVersion")] string? CurrentVersion,
    [property: JsonPropertyName("architecture")] string? Architecture,
    [property: JsonPropertyName("releasePayload")] string? ReleasePayload,
    [property: JsonPropertyName("message")] string? Message);

internal static class ReleaseUpdateChecker
{
    private const string ReleaseApiUrl = "https://api.github.com/repos/sabbour/mizan/releases/latest";
    private const int MaxResponseBytes = 1_048_576;
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(12);
    private static readonly HttpClient Client = new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
    })
    {
        Timeout = System.Threading.Timeout.InfiniteTimeSpan,
    };

    public static async Task<ReleaseUpdateCheckResult> CheckAsync()
    {
        if (!TryGetInstalledIdentity(out var currentVersion, out var architecture))
            return Unsupported("Update checks are available only in the installed Windows app.");

        using var cancellation = new CancellationTokenSource(RequestTimeout);
        return await CheckReleaseAsync(Client, currentVersion.ToString(), architecture, cancellation.Token);
    }

    internal static async Task<ReleaseUpdateCheckResult> CheckReleaseAsync(
        HttpClient client,
        string currentVersion,
        string architecture,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, ReleaseApiUrl);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
            request.Headers.UserAgent.ParseAdd("Mizan-Release-Update-Checker/1.0");
            request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");

            using var response = await client.SendAsync(
                request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                ShellLog.Write($"GitHub release check returned HTTP {(int)response.StatusCode}.");
                return HttpFailure(response.StatusCode);
            }

            var payload = await ReadBoundedAsync(response, cancellationToken);
            var releasePayload = new UTF8Encoding(false, true).GetString(payload);
            return new("checked", currentVersion, architecture, releasePayload, null);
        }
        catch (OperationCanceledException)
        {
            ShellLog.Write("GitHub release check timed out or was cancelled.");
            return Unavailable("The GitHub release check timed out. Check your connection and try again.");
        }
        catch (HttpRequestException error)
        {
            ShellLog.Write($"GitHub release check failed with {error.GetType().Name}.");
            return Unavailable("GitHub Releases could not be reached. Check your connection and try again.");
        }
        catch (Exception error) when (error is InvalidDataException or IOException or DecoderFallbackException)
        {
            ShellLog.Write($"GitHub release check could not read a valid response ({error.GetType().Name}).");
            return Unavailable("GitHub returned an invalid release response. Try again later.");
        }
    }

    private static bool TryGetInstalledIdentity(out ReleaseVersion version, out string architecture)
    {
        version = default;
        architecture = "";
        try
        {
            var package = Package.Current;
            var packageVersion = package.Id.Version;
            version = new(packageVersion.Major, packageVersion.Minor, packageVersion.Build, packageVersion.Revision);
            architecture = package.Id.Architecture switch
            {
                ProcessorArchitecture.X64 when RuntimeInformation.ProcessArchitecture == Architecture.X64 => "x64",
                ProcessorArchitecture.Arm64 when RuntimeInformation.ProcessArchitecture == Architecture.Arm64 => "arm64",
                _ => "",
            };
            return version.IsKnown && architecture.Length > 0;
        }
        catch (Exception error) when (error is InvalidOperationException or COMException)
        {
            ShellLog.Write($"GitHub release checks are unavailable without package identity: {error.Message}");
            return false;
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.Content.Headers.ContentLength is > MaxResponseBytes)
            throw new InvalidDataException("The GitHub release response exceeded the size limit.");

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var contents = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var count = await stream.ReadAsync(buffer, cancellationToken);
            if (count == 0) break;
            if (contents.Length + count > MaxResponseBytes)
                throw new InvalidDataException("The GitHub release response exceeded the size limit.");
            contents.Write(buffer, 0, count);
        }
        return contents.ToArray();
    }

    private static ReleaseUpdateCheckResult HttpFailure(HttpStatusCode statusCode)
    {
        if (statusCode == HttpStatusCode.NotFound)
            return Unavailable("The public GitHub release endpoint was not found. The repository may be private or have no published stable release.");
        if ((int)statusCode == 429 || statusCode == HttpStatusCode.Forbidden)
            return Unavailable("GitHub denied this anonymous release check or temporarily limited it. Try again later.");
        if (statusCode == HttpStatusCode.Unauthorized)
            return Unavailable("GitHub rejected anonymous release checks. Try again later.");
        return Unavailable("GitHub Releases could not be checked. Check your connection and try again.");
    }

    private static ReleaseUpdateCheckResult Unavailable(string message) =>
        new("unavailable", null, null, null, message);

    private static ReleaseUpdateCheckResult Unsupported(string message) =>
        new("unsupported", null, null, null, message);

    private readonly record struct ReleaseVersion(ushort Major, ushort Minor, ushort Build, ushort Revision)
    {
        public bool IsKnown => Major > 0 || Minor > 0 || Build > 0 || Revision > 0;

        public override string ToString() =>
            $"{Major}.{Minor}.{Build}.{Revision}";
    }
}
