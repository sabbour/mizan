using System.Net;
using System.Text;
using Mizan.Shell;

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static HttpClient Client(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) =>
    new(new TestHandler(send)) { Timeout = Timeout.InfiniteTimeSpan };

static async Task<ReleaseUpdateCheckResult> Check(
    Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send,
    string currentVersion,
    string architecture,
    CancellationToken cancellationToken)
{
    using var client = Client(send);
    return await ReleaseUpdateChecker.CheckReleaseAsync(client, currentVersion, architecture, cancellationToken);
}

static HttpResponseMessage Response(HttpStatusCode status, HttpContent? content = null) =>
    new(status) { Content = content ?? new StringContent("sensitive response body", Encoding.UTF8, "application/json") };

var missing = await Check(
    (_, _) => Task.FromResult(Response(HttpStatusCode.NotFound)),
    "0.2.7.0",
    "x64",
    CancellationToken.None);
Assert(missing.Status == "unavailable" && missing.Message!.Contains("private", StringComparison.OrdinalIgnoreCase),
    "HTTP 404 must explain that the public endpoint may be private or unpublished.");
Assert(!missing.Message!.Contains("sensitive", StringComparison.OrdinalIgnoreCase),
    "HTTP error bodies must not be surfaced.");
Assert(ShellLog.Messages.Any(message => message.Contains("HTTP 404", StringComparison.Ordinal)),
    "HTTP 404 failures must be logged.");

foreach (var status in new[] { HttpStatusCode.Forbidden, (HttpStatusCode)429 })
{
    var limited = await Check(
        (_, _) => Task.FromResult(Response(status)),
        "0.2.7.0",
        "x64",
        CancellationToken.None);
    Assert(limited.Status == "unavailable" && limited.Message!.Contains("limited", StringComparison.OrdinalIgnoreCase),
        $"HTTP {(int)status} must report anonymous denial or rate limiting.");
    Assert(!limited.Message!.Contains("sensitive", StringComparison.OrdinalIgnoreCase),
        "Rate-limit response bodies must not be surfaced.");
    Assert(ShellLog.Messages.Any(message => message.Contains($"HTTP {(int)status}", StringComparison.Ordinal)),
        $"HTTP {(int)status} failures must be logged.");
}

using (var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(50)))
{
    var cancelled = await Check(
        async (_, token) =>
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            return Response(HttpStatusCode.OK);
        },
        "0.2.7.0",
        "x64",
        timeout.Token);
    Assert(cancelled.Status == "unavailable" && cancelled.Message!.Contains("timed out", StringComparison.OrdinalIgnoreCase),
        "A cancelled request must return an accurate timeout result.");
    Assert(ShellLog.Messages.Any(message => message.Contains("timed out or was cancelled", StringComparison.Ordinal)),
        "Timeouts and cancellations must be logged.");
}

var oversized = await Check(
    (_, _) => Task.FromResult(Response(
        HttpStatusCode.OK,
        new ByteArrayContent(new byte[1_048_577]))),
    "0.2.7.0",
    "x64",
    CancellationToken.None);
Assert(oversized.Status == "unavailable" && oversized.Message!.Contains("invalid", StringComparison.OrdinalIgnoreCase),
    "Responses larger than 1 MiB must be rejected.");
Assert(ShellLog.Messages.Any(message => message.Contains("InvalidDataException", StringComparison.Ordinal)),
    "Oversized responses must be logged without their contents.");

var streamedOversized = await Check(
    (_, _) => Task.FromResult(Response(
        HttpStatusCode.OK,
        new UnknownLengthContent(new byte[1_048_577]))),
    "0.2.7.0",
    "x64",
    CancellationToken.None);
Assert(streamedOversized.Status == "unavailable" && streamedOversized.Message!.Contains("invalid", StringComparison.OrdinalIgnoreCase),
    "Streaming responses without Content-Length must also be capped.");

var networkFailure = await Check(
    (_, _) => throw new HttpRequestException("fixture network failure"),
    "0.2.7.0",
    "arm64",
    CancellationToken.None);
Assert(networkFailure.Status == "unavailable" && networkFailure.Message!.Contains("connection", StringComparison.OrdinalIgnoreCase),
    "Network errors must return an actionable unavailable result.");
Assert(ShellLog.Messages.Any(message => message.Contains("HttpRequestException", StringComparison.Ordinal)),
    "Network failures must be logged.");

const string payload = "{\"tag_name\":\"v0.2.8\",\"draft\":false,\"prerelease\":false}";
var success = await Check(
    (request, _) =>
    {
        Assert(request.RequestUri!.AbsoluteUri == "https://api.github.com/repos/sabbour/mizan/releases/latest",
            "The checker must call only the canonical public release endpoint.");
        Assert(request.Headers.UserAgent.ToString().Contains("Mizan-Release-Update-Checker"),
            "The request must identify the application.");
        return Task.FromResult(Response(HttpStatusCode.OK, new StringContent(payload, Encoding.UTF8, "application/json")));
    },
    "0.2.7.0",
    "arm64",
    CancellationToken.None);
Assert(success.Status == "checked" && success.CurrentVersion == "0.2.7.0" && success.Architecture == "arm64",
    "Successful responses must preserve injected package identity.");
Assert(success.ReleasePayload == payload, "The bounded response body must be returned intact.");
Assert(ShellLog.Messages.All(message => !message.Contains("sensitive", StringComparison.OrdinalIgnoreCase)
    && !message.Contains(payload, StringComparison.Ordinal)),
    "Diagnostics must not contain HTTP response bodies.");

Console.WriteLine("Native release-check HTTP tests passed: 404/private, 403/429, cancellation, response bound, network failure, canonical endpoint, and architecture identity.");

sealed class TestHandler(
    Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        send(request, cancellationToken);
}

sealed class UnknownLengthContent(byte[] bytes) : HttpContent
{
    protected override Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context) =>
        stream.WriteAsync(bytes.AsMemory()).AsTask();

    protected override Task<Stream> CreateContentReadStreamAsync() =>
        Task.FromResult<Stream>(new MemoryStream(bytes, writable: false));

    protected override bool TryComputeLength(out long length)
    {
        length = 0;
        return false;
    }
}
