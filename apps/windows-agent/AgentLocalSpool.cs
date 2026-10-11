using System.Security.Cryptography;
using System.Text.Json;

namespace QRPrint.Agent;

public sealed record LocalPrintJob(string Id,string LeaseToken,string Mode,string QueueName,string Stage,string SubmissionEventKey,string? ResultEventKey=null,string? ResultStatus=null,string? ResultError=null);

/// <summary>Per-user durable spool. Metadata (including lease tokens) is protected with current-user DPAPI.</summary>
public static class AgentLocalSpool {
    private static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"QRPrint","Jobs");
    private static string JobDirectory(string id) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(id,"^[A-Za-z0-9_-]{1,100}$"))throw new InvalidOperationException("Invalid job identifier.");
        var root=Path.GetFullPath(Root);
        var directory=Path.GetFullPath(Path.Combine(root,id));
        if(!directory.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Spool path escaped its restricted root.");
        return directory;
    }
    private static string EncryptedDocumentPath(string id)=>Path.Combine(JobDirectory(id),"document.dpapi");
    public static string DocumentPath(string id)=>EncryptedDocumentPath(id);
    public static async Task<LocalPrintJob> SaveDownloadedAsync(string id,string leaseToken,string mode,string queueName,byte[] pdf) {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("Durable agent spool metadata uses Windows DPAPI.");
        var directory=JobDirectory(id);Directory.CreateDirectory(directory);
        var document=EncryptedDocumentPath(id);
        if(!File.Exists(document)){
            byte[] protectedPdf;
            try{protectedPdf=AgentLocalSettings.ProtectLocalData(pdf);}finally{CryptographicOperations.ZeroMemory(pdf);}
            try{await AtomicWriteAsync(document,protectedPdf);}finally{CryptographicOperations.ZeroMemory(protectedPdf);}
        }
        var entry=new LocalPrintJob(id,leaseToken,mode,queueName,"DOWNLOADED",$"submit-{Guid.NewGuid():N}");
        await SaveAsync(entry);return entry;
    }
    public static async Task SaveAsync(LocalPrintJob entry) {
        var clear=JsonSerializer.SerializeToUtf8Bytes(entry);
        byte[] protectedBytes;
        try{protectedBytes=AgentLocalSettings.ProtectLocalData(clear);}finally{CryptographicOperations.ZeroMemory(clear);}
        try{await AtomicWriteAsync(Path.Combine(JobDirectory(entry.Id),"job.dpapi"),protectedBytes);}finally{CryptographicOperations.ZeroMemory(protectedBytes);}
    }
    public static async Task<IReadOnlyList<LocalPrintJob>> LoadAllAsync() {
        if(!Directory.Exists(Root))return [];
        var result=new List<LocalPrintJob>();
        foreach(var file in Directory.EnumerateFiles(Root,"job.dpapi",SearchOption.AllDirectories)){
            try{
                var encrypted=await File.ReadAllBytesAsync(file);var clear=AgentLocalSettings.UnprotectLocalData(encrypted);
                try{var entry=JsonSerializer.Deserialize<LocalPrintJob>(clear);if(entry is not null&&File.Exists(EncryptedDocumentPath(entry.Id))){result.Add(entry);foreach(var stale in Directory.EnumerateFiles(JobDirectory(entry.Id),"submit-*.pdf"))try{File.Delete(stale);}catch{}}}
                finally{CryptographicOperations.ZeroMemory(clear);}
            }catch(Exception ex) when(ex is CryptographicException or JsonException or IOException or InvalidOperationException){Console.Error.WriteLine("A local job spool record could not be read; it has been retained for manual recovery.");}
        }
        return result;
    }
    public static async Task<string> CreateSubmissionCopyAsync(string id){var encrypted=await File.ReadAllBytesAsync(DocumentPath(id));var clear=AgentLocalSettings.UnprotectLocalData(encrypted);var path=Path.Combine(JobDirectory(id),$"submit-{Guid.NewGuid():N}.pdf");try{await File.WriteAllBytesAsync(path,clear);return path;}finally{CryptographicOperations.ZeroMemory(clear);}}
    public static Task DeleteSubmissionCopyAsync(string id,string path)=>Task.Run(()=>{var full=Path.GetFullPath(path);var jobRoot=Path.GetFullPath(JobDirectory(id))+Path.DirectorySeparatorChar;if(!full.StartsWith(jobRoot,StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(full).StartsWith("submit-",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Refusing to delete a file outside this job's temporary spool files.");if(File.Exists(full))File.Delete(full);});
    public static Task DeleteAsync(string id)=>Task.Run(()=>{var directory=JobDirectory(id);if(Directory.Exists(directory))Directory.Delete(directory,true);});
    private static async Task AtomicWriteAsync(string destination,byte[] data) {
        var temp=destination+"."+Guid.NewGuid().ToString("N")+".tmp";
        try{await File.WriteAllBytesAsync(temp,data);File.Move(temp,destination,true);}finally{try{File.Delete(temp);}catch{}}
    }
}
