using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace QRPrint.Agent;

public sealed record AgentSettings(string ApiUrl, string Mode);

public static class AgentLocalSettings {
    private const string ProductDirectory = "QRPrint";
    private static string DirectoryPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), ProductDirectory);
    private static string SettingsPath => Path.Combine(DirectoryPath, "agent-settings.json");
    private static string SecretPath => Path.Combine(DirectoryPath, "agent-credential.dpapi");

    [StructLayout(LayoutKind.Sequential)] private struct DataBlob { public int Size; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CryptProtectData(ref DataBlob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CryptUnprotectData(ref DataBlob input, out IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LocalFree(IntPtr memory);

    public static async Task SaveAsync(AgentSettings settings, string credential) {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Agent credentials are protected with Windows DPAPI.");
        Directory.CreateDirectory(DirectoryPath);
        await File.WriteAllTextAsync(SettingsPath, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented=true }));
        var bytes=Encoding.UTF8.GetBytes(credential);
        try { await File.WriteAllBytesAsync(SecretPath, Protect(bytes)); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    public static AgentSettings? LoadSettings() {
        if (!File.Exists(SettingsPath)) return null;
        try { return JsonSerializer.Deserialize<AgentSettings>(File.ReadAllText(SettingsPath)); }
        catch (JsonException) { return null; }
    }

    public static string? LoadCredential() {
        if (!OperatingSystem.IsWindows() || !File.Exists(SecretPath)) return null;
        var clear=Unprotect(File.ReadAllBytes(SecretPath));
        try { return Encoding.UTF8.GetString(clear); }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }

    private static byte[] Protect(byte[] bytes) => Transform(bytes, protect:true);
    private static byte[] Unprotect(byte[] bytes) => Transform(bytes, protect:false);
    internal static byte[] ProtectLocalData(byte[] bytes) => Protect(bytes);
    internal static byte[] UnprotectLocalData(byte[] bytes) => Unprotect(bytes);
    private static byte[] Transform(byte[] bytes, bool protect) {
        var inputPtr=Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes,0,inputPtr,bytes.Length);
        var input=new DataBlob { Size=bytes.Length, Data=inputPtr };
        DataBlob output=default;
        IntPtr description=IntPtr.Zero;
        try {
            var ok=protect
                ? CryptProtectData(ref input,"QR Print device credential",IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,out output)
                : CryptUnprotectData(ref input,out description,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,out output);
            if (!ok) throw new CryptographicException(Marshal.GetLastWin32Error());
            var result=new byte[output.Size];
            Marshal.Copy(output.Data,result,0,output.Size);
            return result;
        } finally {
            CryptographicOperations.ZeroMemory(bytes);
            Marshal.FreeHGlobal(inputPtr);
            if (output.Data!=IntPtr.Zero) _=LocalFree(output.Data);
            if (description!=IntPtr.Zero) _=LocalFree(description);
        }
    }
}
