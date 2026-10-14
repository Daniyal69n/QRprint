using System.Security.Cryptography;
using System.Text.Json;

namespace QRPrint.Agent;

public sealed record LocalPrintJob(string Id,string LeaseToken,string Mode,string QueueName,string Stage,string SubmissionEventKey,string ShopId,bool DoubleSided=false,string? ResultEventKey=null,string? ResultStatus=null,string? ResultError=null,string FileExtension="pdf",string? PageRange=null);

/// <summary>Per-user durable spool. Metadata (including lease tokens) is protected with current-user DPAPI.</summary>
public static class AgentLocalSpool {
    private static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"QRPrint","Jobs");
    private static string JobDirectory(string shopId,string id) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(shopId,"^[A-Za-z0-9_-]{1,100}$")||!System.Text.RegularExpressions.Regex.IsMatch(id,"^[A-Za-z0-9_-]{1,100}$"))throw new InvalidOperationException("Invalid shop or job identifier.");
        var root=Path.GetFullPath(Root);
        var directory=Path.GetFullPath(Path.Combine(root,shopId,id));
        if(!directory.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Spool path escaped its restricted root.");
        return directory;
    }
    private static string EncryptedDocumentPath(string shopId,string id)=>Path.Combine(JobDirectory(shopId,id),"document.dpapi");
    public static string DocumentPath(string shopId,string id)=>EncryptedDocumentPath(shopId,id);
    public static async Task<LocalPrintJob> SaveDownloadedAsync(string shopId,string id,string leaseToken,string mode,string queueName,bool doubleSided,byte[] documentBytes,string fileExtension="pdf",string? pageRange=null) {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("Durable agent spool metadata uses Windows DPAPI.");
        var directory=JobDirectory(shopId,id);Directory.CreateDirectory(directory);
        var document=EncryptedDocumentPath(shopId,id);
        if(!File.Exists(document)){
            byte[] protectedDoc;
            try{protectedDoc=AgentLocalSettings.ProtectLocalData(documentBytes);}finally{CryptographicOperations.ZeroMemory(documentBytes);}
            try{await AtomicWriteAsync(document,protectedDoc);}finally{CryptographicOperations.ZeroMemory(protectedDoc);}
        }
        var ext=string.IsNullOrWhiteSpace(fileExtension)?"pdf":fileExtension.Trim('.').ToLowerInvariant();
        if(ext!="pdf"&&ext!="docx")ext="pdf";
        var entry=new LocalPrintJob(id,leaseToken,mode,queueName,"DOWNLOADED",$"submit-{Guid.NewGuid():N}",shopId,doubleSided,FileExtension:ext,PageRange:pageRange);
        await SaveAsync(entry);return entry;
    }
    public static async Task SaveAsync(LocalPrintJob entry) {
        var clear=JsonSerializer.SerializeToUtf8Bytes(entry);
        byte[] protectedBytes;
        try{protectedBytes=AgentLocalSettings.ProtectLocalData(clear);}finally{CryptographicOperations.ZeroMemory(clear);}
        try{await AtomicWriteAsync(Path.Combine(JobDirectory(entry.ShopId,entry.Id),"job.dpapi"),protectedBytes);}finally{CryptographicOperations.ZeroMemory(protectedBytes);}
    }
    public static async Task<IReadOnlyList<LocalPrintJob>> LoadAllAsync(string shopId) {
        var shopRoot=Path.Combine(Root,shopId);
        if(!Directory.Exists(shopRoot))return [];
        var result=new List<LocalPrintJob>();
        foreach(var file in Directory.EnumerateFiles(shopRoot,"job.dpapi",SearchOption.AllDirectories)){
            try{
                var encrypted=await File.ReadAllBytesAsync(file);var clear=AgentLocalSettings.UnprotectLocalData(encrypted);
                try{var entry=JsonSerializer.Deserialize<LocalPrintJob>(clear);if(entry is not null&&entry.ShopId==shopId&&File.Exists(EncryptedDocumentPath(entry.ShopId,entry.Id))){result.Add(entry);foreach(var stale in Directory.EnumerateFiles(JobDirectory(entry.ShopId,entry.Id),"submit-*.*"))try{File.Delete(stale);}catch{}}}
                finally{CryptographicOperations.ZeroMemory(clear);}
            }catch(Exception ex) when(ex is CryptographicException or JsonException or IOException or InvalidOperationException){Console.Error.WriteLine("A local job spool record could not be read; it has been retained for manual recovery.");}
        }
        return result;
    }
    public static async Task<string> CreateSubmissionCopyAsync(string shopId,string id,string fileExtension="pdf"){var encrypted=await File.ReadAllBytesAsync(DocumentPath(shopId,id));var clear=AgentLocalSettings.UnprotectLocalData(encrypted);var ext=string.IsNullOrWhiteSpace(fileExtension)?"pdf":fileExtension.Trim('.').ToLowerInvariant();if(ext!="pdf"&&ext!="docx")ext="pdf";var path=Path.Combine(JobDirectory(shopId,id),$"submit-{Guid.NewGuid():N}.{ext}");try{await File.WriteAllBytesAsync(path,clear);return path;}finally{CryptographicOperations.ZeroMemory(clear);}}
    public static Task DeleteSubmissionCopyAsync(string shopId,string id,string path)=>Task.Run(()=>{var full=Path.GetFullPath(path);var jobRoot=Path.GetFullPath(JobDirectory(shopId,id))+Path.DirectorySeparatorChar;if(!full.StartsWith(jobRoot,StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(full).StartsWith("submit-",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Refusing to delete a file outside this job's temporary spool files.");if(File.Exists(full))File.Delete(full);});
    public static Task DeleteAsync(string shopId,string id)=>Task.Run(()=>{var directory=JobDirectory(shopId,id);if(Directory.Exists(directory))Directory.Delete(directory,true);});
    private static async Task AtomicWriteAsync(string destination,byte[] data) {
        var temp=destination+"."+Guid.NewGuid().ToString("N")+".tmp";
        try{await File.WriteAllBytesAsync(temp,data);File.Move(temp,destination,true);}finally{try{File.Delete(temp);}catch{}}
    }
}
