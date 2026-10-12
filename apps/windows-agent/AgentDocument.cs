namespace QRPrint.Agent;

public sealed record DocumentDownloadResult(byte[] Bytes, int StatusCode, string ContentType, string Source, int ByteCount, string? StorageHost, long ElapsedMs, string DocumentType = "pdf");

public static class AgentDocument {
    public const int DocumentTimeoutSeconds = 180;

    public static bool HasPdfMagic(ReadOnlySpan<byte> bytes) =>
        bytes.Length >= 5 && bytes[0]==(byte)'%' && bytes[1]==(byte)'P' && bytes[2]==(byte)'D' && bytes[3]==(byte)'F' && bytes[4]==(byte)'-';

    public static bool HasDocxMagic(ReadOnlySpan<byte> bytes) =>
        bytes.Length >= 4 && bytes[0]==0x50 && bytes[1]==0x4B && bytes[2]==0x03 && bytes[3]==0x04;

    public static string DescribeOrigin(string? url) {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return "invalid-url";
        return $"{uri.Scheme}://{uri.Host}";
    }

    public static bool ContainsSecretQuery(string text) =>
        text.Contains('?', StringComparison.Ordinal) || text.Contains("token=", StringComparison.OrdinalIgnoreCase);

    public static bool CanClaimNext(string? inFlightJobId) => string.IsNullOrEmpty(inFlightJobId);

    public static bool CanClaimNextAfter(string outcome) =>
        outcome is "SUBMITTED" or "FAILED_REPORTED" or "LEASE_RELEASED" or "NO_JOB";
}
