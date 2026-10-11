using System.Diagnostics;
using System.Drawing.Printing;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace QRPrint.Agent;

public record PrinterCapabilities(string Source, bool SupportsColor, bool CanDuplex, string[] PaperSizes, string[] Resolutions);
public record PrinterInfo(string Name, bool InstalledQueue, bool Available, string Status, bool IsDefault, PrinterCapabilities? Capabilities = null);
public record PrintResult(bool Accepted, string Status, string? QueueName, string? Detail);
public interface IPrinterAdapter { Task<IReadOnlyList<PrinterInfo>> DiscoverAsync(); Task<PrintResult> SubmitPdfAsync(string queueName, string pdfPath); }

public sealed class SimulatedPrinterAdapter : IPrinterAdapter {
    public Task<IReadOnlyList<PrinterInfo>> DiscoverAsync() => Task.FromResult<IReadOnlyList<PrinterInfo>>([new("SIMULATED-ONLY", false, true, "SIMULATED", false)]);
    public async Task<PrintResult> SubmitPdfAsync(string queueName, string pdfPath) {
        if (!File.Exists(pdfPath)) return new(false,"FAILED",queueName,"PDF file does not exist");
        Console.WriteLine("SIMULATED: queued job; no printer accessed and no pages printed.");
        await Task.Delay(500);
        return new(true,"SIMULATED_COMPLETED",queueName,"Simulation only; no physical print occurred.");
    }
}

public sealed class WindowsQueueAdapter : IPrinterAdapter {
    [StructLayout(LayoutKind.Sequential)] private struct PrinterInfo6 { public uint Status; }
    [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError=true)] private static extern bool GetPrinter(IntPtr handle, uint level, IntPtr buffer, uint size, out uint needed);
    [DllImport("winspool.drv", SetLastError=true)] private static extern bool ClosePrinter(IntPtr handle);

    private static (bool Available,string Status) ReadQueueStatus(string name) {
        if (!OpenPrinter(name,out var handle,IntPtr.Zero)) return (false,"UNAVAILABLE");
        try {
            _=GetPrinter(handle,6,IntPtr.Zero,0,out var needed);
            if (needed < Marshal.SizeOf<PrinterInfo6>()) return (false,"STATUS_UNAVAILABLE");
            var buffer=Marshal.AllocHGlobal((int)needed);
            try {
                if (!GetPrinter(handle,6,buffer,needed,out _)) return (false,"STATUS_UNAVAILABLE");
                var status=Marshal.PtrToStructure<PrinterInfo6>(buffer).Status;
                const uint unavailableFlags=0x00000001|0x00000002|0x00000010|0x00000080|0x00001000;
                if ((status&unavailableFlags)!=0) return (false,$"SPOOLER_UNAVAILABLE_0x{status:X}");
                return (true,status==0?"SPOOLER_READY_UNCONFIRMED":"SPOOLER_STATUS_UNCONFIRMED");
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally { _=ClosePrinter(handle); }
    }

    public Task<IReadOnlyList<PrinterInfo>> DiscoverAsync() {
        if (!OperatingSystem.IsWindows()) return Task.FromResult<IReadOnlyList<PrinterInfo>>([]);
        var names = PrinterSettings.InstalledPrinters.Cast<string>().ToArray();
        var printers = names.Select(name => {
            var settings = new PrinterSettings { PrinterName = name };
            var probe=settings.IsValid?ReadQueueStatus(name):(false,"QUEUE_NOT_INSTALLED");
            var caps=settings.IsValid?new PrinterCapabilities("WINDOWS_DRIVER_QUEUE",settings.SupportsColor,settings.CanDuplex,settings.PaperSizes.Cast<System.Drawing.Printing.PaperSize>().Select(p=>p.PaperName).Distinct(StringComparer.OrdinalIgnoreCase).Order().ToArray(),settings.PrinterResolutions.Cast<PrinterResolution>().Select(r=>$"{r.Kind}:{r.X}x{r.Y}dpi").Distinct().Order().ToArray()):null;
            return new PrinterInfo(name, settings.IsValid, settings.IsValid&&probe.Item1, probe.Item2, settings.IsDefaultPrinter,caps);
        }).ToArray();
        return Task.FromResult<IReadOnlyList<PrinterInfo>>(printers);
    }

    public async Task<PrintResult> SubmitPdfAsync(string queueName, string pdfPath) {
        if (!OperatingSystem.IsWindows()) return new(false,"UNAVAILABLE",queueName,"Windows printer queues are available only on Windows.");
        var settings = new PrinterSettings { PrinterName = queueName };
        if (!settings.IsValid) return new(false,"UNAVAILABLE",queueName,"The selected printer queue is not installed or available.");
        var probe=ReadQueueStatus(queueName);
        if (!probe.Available) return new(false,"UNAVAILABLE",queueName,$"Windows spooler reports the queue unavailable ({probe.Status}).");
        if (!File.Exists(pdfPath)) return new(false,"FAILED",queueName,"PDF file does not exist");
        var renderer = Environment.GetEnvironmentVariable("QRPRINT_PDF_PRINT_COMMAND");
        if (string.IsNullOrWhiteSpace(renderer) || !File.Exists(renderer)) return new(false,"UNAVAILABLE",queueName,"Configure QRPRINT_PDF_PRINT_COMMAND to a trusted PDF renderer executable before submitting jobs.");
        // Renderer integration is intentionally delegated to an installed PDF tool. The tool's
        // command line must be provided via QRPRINT_PDF_PRINT_ARGS with {printer} and {file}.
        var template = Environment.GetEnvironmentVariable("QRPRINT_PDF_PRINT_ARGS") ?? "-print-to \"{printer}\" \"{file}\"";
        var args = template.Replace("{printer}", queueName).Replace("{file}", pdfPath);
        using var process = Process.Start(new ProcessStartInfo(renderer, args) { UseShellExecute=false, CreateNoWindow=true });
        if (process is null) return new(false,"FAILED",queueName,"PDF renderer did not start.");
        await process.WaitForExitAsync();
        if (process.ExitCode != 0) return new(false,"FAILED",queueName,$"PDF renderer exited with code {process.ExitCode}.");
        return new(true,"SPOOLER_ACCEPTED",queueName,"The configured renderer returned success and the queue was not marked unavailable. This does not confirm paper output.");
    }
}

public static class Program {
    private static object ToObservedQueue(PrinterInfo printer) => new {
        name=printer.Name, installedQueue=printer.InstalledQueue, available=printer.Available, status=printer.Status,
        capabilities=printer.Capabilities is null ? null : new {
            source=printer.Capabilities.Source,
            supportsColor=printer.Capabilities.SupportsColor,
            canDuplex=printer.Capabilities.CanDuplex,
            paperSizes=printer.Capabilities.PaperSizes,
            resolutions=printer.Capabilities.Resolutions
        }
    };

    private static async Task ReportAsync(AgentApiClient api,string jobId,string leaseToken,string status,string eventKey,string? error=null,string? externalJobId=null) {
        Exception? last=null;
        for(var attempt=0;attempt<4;attempt++){
            try { using var response=await api.PostAsync($"agent/jobs/{Uri.EscapeDataString(jobId)}/status",new {eventKey,status,leaseToken,error,externalJobId});return; }
            catch(Exception ex) when(attempt<3){last=ex;await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2,attempt)));}
        }
        throw new InvalidOperationException("Could not report agent job status; the lease will expire and submission outcome will be reconciled.",last);
    }

    private static async Task<LocalPrintJob> SetPendingResultAsync(LocalPrintJob entry,string status,string? error=null) {
        var updated=entry with {Stage="RESULT_PENDING",ResultStatus=status,ResultEventKey=entry.ResultEventKey??$"result-{Guid.NewGuid():N}",ResultError=error};
        await AgentLocalSpool.SaveAsync(updated);return updated;
    }

    private static bool IsResolved(JsonElement state) {
        var status=state.GetProperty("status").GetString();var physical=state.GetProperty("physicalStatus").GetString();
        return status == "SIMULATED_COMPLETE" ||
            (status == "CANCELLED" && physical == "NOT_SUBMITTED") ||
            (status == "FAILED" && physical == "NOT_SUBMITTED") ||
            physical == "OUTPUT_CONFIRMED";
    }

    private static async Task SyncSpoolEntryAsync(AgentApiClient api,IPrinterAdapter adapter,LocalPrintJob entry) {
        JsonDocument response;
        try { response=await api.GetJobStateAsync(entry.Id,entry.LeaseToken); }
        catch(Exception ex){Console.Error.WriteLine($"Local job {entry.Id} retained; API is unavailable: {ex.Message}");return;}
        using(response){
            var state=response.RootElement;var status=state.GetProperty("status").GetString()??"";var leaseOwned=state.GetProperty("leaseOwned").GetBoolean();
            if(IsResolved(state)){await AgentLocalSpool.DeleteAsync(entry.Id);Console.WriteLine($"Local file for resolved job {entry.Id} was removed.");return;}
            if(status=="QUEUED"&&(entry.Stage is "DOWNLOADED" or "SUBMISSION_INTENT")) {await AgentLocalSpool.DeleteAsync(entry.Id);return;}
            if(status=="OUTCOME_UNKNOWN"){
                if(entry.Stage is "SUBMISSION_INTENT" or "SUBMITTING"){
                    entry=await SetPendingResultAsync(entry,"OUTCOME_UNKNOWN","Agent restarted or lost connectivity after submission began; operator reconciliation is required.");
                    if(leaseOwned)try{await ReportAsync(api,entry.Id,entry.LeaseToken,"OUTCOME_UNKNOWN",entry.ResultEventKey!,entry.ResultError);}catch{}
                }
                return;
            }
            if(entry.Stage=="RESULT_PENDING"){
                if(status==entry.ResultStatus){entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}
                else if(leaseOwned&&status=="SUBMITTING"){
                    try{await ReportAsync(api,entry.Id,entry.LeaseToken,entry.ResultStatus!,entry.ResultEventKey!,entry.ResultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}catch{return;}
                } else return;
            }
            if(entry.Stage=="RESULT_REPORTED")return; // Keep spool files until the server records a resolved outcome.
            if(entry.Stage=="SUBMITTING"){
                // A restart after submission intent is ambiguous. Never submit this file again.
                entry=await SetPendingResultAsync(entry,"OUTCOME_UNKNOWN","Agent restarted after submission began; operator reconciliation is required.");
                if(leaseOwned)try{await ReportAsync(api,entry.Id,entry.LeaseToken,"OUTCOME_UNKNOWN",entry.ResultEventKey!,entry.ResultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}catch{}
                return;
            }
            if(entry.Stage=="SUBMISSION_INTENT"&&status=="SUBMITTING"){
                entry=await SetPendingResultAsync(entry,"OUTCOME_UNKNOWN","Submission status was accepted before the agent could persist its acknowledgement.");
                if(leaseOwned)try{await ReportAsync(api,entry.Id,entry.LeaseToken,"OUTCOME_UNKNOWN",entry.ResultEventKey!,entry.ResultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}catch{}
                return;
            }
            if(entry.Stage is "DOWNLOADED" or "SUBMISSION_INTENT"){
                if(!leaseOwned||status is not("LEASED" or "DOWNLOADED")){if(status is "FAILED" or "CANCELLED" or "QUEUED")await AgentLocalSpool.DeleteAsync(entry.Id);return;}
                await SubmitDownloadedAsync(api,adapter,entry);
            }
        }
    }

    private static async Task SubmitDownloadedAsync(AgentApiClient api,IPrinterAdapter adapter,LocalPrintJob entry) {
        var available=(await adapter.DiscoverAsync()).Any(p=>p.Name.Equals(entry.QueueName,StringComparison.OrdinalIgnoreCase)&&p.Available);
        if(entry.Mode=="REAL"&&!available){entry=await SetPendingResultAsync(entry,"FAILED","Assigned Windows queue is unavailable before submission; no print was attempted.");try{await ReportAsync(api,entry.Id,entry.LeaseToken,entry.ResultStatus!,entry.ResultEventKey!,entry.ResultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}catch{}return;}
        var renderer=Environment.GetEnvironmentVariable("QRPRINT_PDF_PRINT_COMMAND");
        if(entry.Mode=="REAL"&&(string.IsNullOrWhiteSpace(renderer)||!File.Exists(renderer))){entry=await SetPendingResultAsync(entry,"FAILED","Trusted PDF renderer is not configured; no submission was attempted.");try{await ReportAsync(api,entry.Id,entry.LeaseToken,entry.ResultStatus!,entry.ResultEventKey!,entry.ResultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}catch{}return;}
        if(entry.Stage=="DOWNLOADED")entry=entry with{Stage="SUBMISSION_INTENT"};
        await AgentLocalSpool.SaveAsync(entry);
        try{await ReportAsync(api,entry.Id,entry.LeaseToken,"SUBMITTING",entry.SubmissionEventKey);}
        catch(Exception ex){Console.Error.WriteLine($"Job {entry.Id} is safely retained; submission was not attempted because the API did not acknowledge it: {ex.Message}");return;}
        entry=entry with{Stage="SUBMITTING"};await AgentLocalSpool.SaveAsync(entry);
        string resultStatus,resultError="";
        try{
            var submissionCopy=await AgentLocalSpool.CreateSubmissionCopyAsync(entry.Id);
            PrintResult result;
            try { result=await adapter.SubmitPdfAsync(entry.QueueName,submissionCopy); }
            finally { await AgentLocalSpool.DeleteSubmissionCopyAsync(entry.Id,submissionCopy); }
            if(entry.Mode=="SIMULATED"&&result.Accepted)resultStatus="SIMULATED_COMPLETE";
            else if(entry.Mode=="REAL"&&result.Accepted)resultStatus="SPOOLER_ACCEPTED";
            else resultStatus="OUTCOME_UNKNOWN";
            resultError=result.Detail??"";
        }catch(Exception ex){resultStatus="OUTCOME_UNKNOWN";resultError=ex.Message.Length>450?ex.Message[..450]:ex.Message;}
        entry=await SetPendingResultAsync(entry,resultStatus,resultError);
        try{await ReportAsync(api,entry.Id,entry.LeaseToken,resultStatus,entry.ResultEventKey!,resultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);Console.WriteLine(resultStatus=="SIMULATED_COMPLETE"?"SIMULATED ONLY: no physical pages were printed.":resultStatus=="SPOOLER_ACCEPTED"?"Windows spooler accepted the command. Physical output remains unconfirmed.":$"Job {entry.Id} has an unknown outcome; do not resubmit it.");}
        catch(Exception ex){Console.Error.WriteLine($"Job result retained for retry after reconnection: {ex.Message}");}
    }

    private static async Task RunConnectedAsync(string baseUrl,string credential,string requestedMode){
        using var api=new AgentApiClient(baseUrl,credential);
        using var stop=new CancellationTokenSource();
        Task? keepAlive=null;
        try {
            JsonDocument initialHeartbeat;
            while(true){try{initialHeartbeat=await api.PostAsync("agent/heartbeat",new {ping=true});break;}catch(Exception ex){Console.Error.WriteLine($"API is unavailable; reconnecting in five seconds: {ex.Message}");await Task.Delay(TimeSpan.FromSeconds(5));}}
            using var heartbeat=initialHeartbeat;
            var device=heartbeat.RootElement.GetProperty("device");
            var mode=device.GetProperty("mode").GetString()??"";
            if(!mode.Equals(requestedMode,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException($"Enrolled agent mode is {mode}; configured mode is {requestedMode}. Re-enroll or configure the correct mode.");
            var printer=heartbeat.RootElement.GetProperty("printer");
            var queueName=printer.GetProperty("queueName").GetString()??"";
            IPrinterAdapter adapter=mode.Equals("REAL",StringComparison.OrdinalIgnoreCase)?new WindowsQueueAdapter():new SimulatedPrinterAdapter();
            Console.WriteLine($"Connected to QR Print API as {device.GetProperty("name").GetString()} ({mode}). Printer queue: {queueName}");
            PrinterInfo? reported=null;
            if(mode=="REAL"){
                reported=(await adapter.DiscoverAsync()).FirstOrDefault(p=>p.Name.Equals(queueName,StringComparison.OrdinalIgnoreCase))??new PrinterInfo(queueName,false,false,"QUEUE_NOT_INSTALLED",false);
                using var observed=await api.PostAsync("agent/heartbeat",new {observedQueue=ToObservedQueue(reported)});
                if(!reported.Available)Console.Error.WriteLine($"UNAVAILABLE: assigned Windows queue '{queueName}' is not currently available. No print will be reported as successful.");
            } else {
                using var simulatedHeartbeat=await api.PostAsync("agent/heartbeat",new {ping=true});
                Console.WriteLine("SIMULATED ONLY: this agent will not inspect or access a Windows printer queue.");
            }
            keepAlive=Task.Run(async()=>{while(!stop.IsCancellationRequested){try{if(mode=="REAL"){var current=(await adapter.DiscoverAsync()).FirstOrDefault(p=>p.Name.Equals(queueName,StringComparison.OrdinalIgnoreCase))??new PrinterInfo(queueName,false,false,"QUEUE_NOT_INSTALLED",false);using var h=await api.PostAsync("agent/heartbeat",new {observedQueue=ToObservedQueue(current)},stop.Token);Console.WriteLine($"Heartbeat accepted; assigned queue status: {current.Status}.");}else{using var h=await api.PostAsync("agent/heartbeat",new {ping=true},stop.Token);Console.WriteLine("Simulated heartbeat accepted; no Windows printer queue was accessed.");}}catch(OperationCanceledException) when(stop.IsCancellationRequested){break;}catch(Exception ex){Console.Error.WriteLine($"API heartbeat failed: {ex.Message}");}try{await Task.Delay(TimeSpan.FromSeconds(15),stop.Token);}catch(OperationCanceledException){break;}}});
            while(true){
                foreach(var localJob in await AgentLocalSpool.LoadAllAsync())await SyncSpoolEntryAsync(api,adapter,localJob);
                JsonDocument claim;
                try { claim=await api.PostAsync("agent/jobs/claim",new {ping=true}); }
                catch(Exception ex){Console.Error.WriteLine($"Job claim failed; reconnecting in five seconds: {ex.Message}");await Task.Delay(TimeSpan.FromSeconds(5));continue;}
                using var claimDocument=claim;
                var job=claimDocument.RootElement.GetProperty("job");
                if(job.ValueKind==JsonValueKind.Null){await Task.Delay(TimeSpan.FromSeconds(3));continue;}
                var id=job.GetProperty("id").GetString()!;var token=job.GetProperty("leaseToken").GetString()!;
                Console.WriteLine($"Claimed job {id} ({mode}); downloading fitted PDF.");
                try {
                    var bytes=await api.DownloadAsync(id,token);
                    var local=await AgentLocalSpool.SaveDownloadedAsync(id,token,mode,queueName,bytes);System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes);
                    await SyncSpoolEntryAsync(api,adapter,local);
                } catch(Exception ex){Console.Error.WriteLine($"Job {id} was not submitted; local download persistence or delivery failed: {ex.Message}");}
            }
        } finally {stop.Cancel();if(keepAlive is not null)try{await keepAlive;}catch{}}
    }

    [STAThread]
    public static async Task Main(string[] args) {
        if(args.Contains("--onboard",StringComparer.OrdinalIgnoreCase)){_=FreeConsole();await AgentOnboarding.RunAsync();return;}
        if(args.Contains("--discover",StringComparer.OrdinalIgnoreCase)){
            var discovered=await new WindowsQueueAdapter().DiscoverAsync();
            Console.WriteLine(JsonSerializer.Serialize(discovered,new JsonSerializerOptions { WriteIndented=true }));
            if(discovered.Count==0)Console.WriteLine("UNAVAILABLE: no installed Windows printer queue detected. No print was attempted.");
            return;
        }
        var saved=AgentLocalSettings.LoadSettings();
        var modeIndex=Array.IndexOf(args,"--mode");
        var mode = (modeIndex>=0 ? args.ElementAtOrDefault(modeIndex+1) : Environment.GetEnvironmentVariable("PRINT_AGENT_MODE")) ?? saved?.Mode ?? "simulated";
        if(!mode.Equals("simulated",StringComparison.OrdinalIgnoreCase)&&!mode.Equals("real",StringComparison.OrdinalIgnoreCase)){Console.Error.WriteLine("PRINT_AGENT_MODE must be simulated or real.");return;}
        var apiUrl=Environment.GetEnvironmentVariable("QRPRINT_API_URL")??saved?.ApiUrl;var credential=Environment.GetEnvironmentVariable("QRPRINT_AGENT_TOKEN")??AgentLocalSettings.LoadCredential();
        if(!string.IsNullOrWhiteSpace(apiUrl)||!string.IsNullOrWhiteSpace(credential)){
            if(string.IsNullOrWhiteSpace(apiUrl)||string.IsNullOrWhiteSpace(credential)){Console.Error.WriteLine("Set both QRPRINT_API_URL and QRPRINT_AGENT_TOKEN to run connected mode.");return;}
            await RunConnectedAsync(apiUrl,credential,mode);return;
        }
        IPrinterAdapter adapter = mode.Equals("real",StringComparison.OrdinalIgnoreCase) ? new WindowsQueueAdapter() : new SimulatedPrinterAdapter();
        Console.WriteLine($"QR Print agent mode: {mode.ToUpperInvariant()}");
        var printers = await adapter.DiscoverAsync();
        Console.WriteLine(JsonSerializer.Serialize(printers,new JsonSerializerOptions { WriteIndented=true }));
        if (printers.Count == 0) Console.WriteLine("UNAVAILABLE: no installed printer queue detected. No print was attempted.");
        var printIndex=Array.IndexOf(args,"--print");
        if(printIndex>=0){
            if(args.Length<=printIndex+2){Console.Error.WriteLine("Usage: --mode <simulated|real> --print <queue-name> <pdf-path>");return;}
            var result=await adapter.SubmitPdfAsync(args[printIndex+1],args[printIndex+2]);
            Console.WriteLine(JsonSerializer.Serialize(result,new JsonSerializerOptions { WriteIndented=true }));
            if(result.Status=="SPOOLER_ACCEPTED")Console.WriteLine("Queue accepted the command. Physical paper output is not confirmed.");
            return;
        }
        if (mode.Equals("simulated",StringComparison.OrdinalIgnoreCase)) Console.WriteLine("Simulation adapter is isolated from Windows printing and never reports a real print.");
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool FreeConsole();
}
