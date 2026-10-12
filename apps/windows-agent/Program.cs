using System.Diagnostics;
using System.Drawing.Printing;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace QRPrint.Agent;

public record PrinterCapabilities(string Source, bool SupportsColor, bool CanDuplex, string[] PaperSizes, string[] Resolutions);
public record PrinterInfo(string Name, bool InstalledQueue, bool Available, string Status, bool IsDefault, PrinterCapabilities? Capabilities = null);
public record PrintResult(bool Accepted, string Status, string? QueueName, string? Detail);
public interface IPrinterAdapter { Task<IReadOnlyList<PrinterInfo>> DiscoverAsync(); Task<PrintResult> SubmitPdfAsync(string queueName, string pdfPath, bool doubleSided = false); }

public sealed class SimulatedPrinterAdapter : IPrinterAdapter {
    public Task<IReadOnlyList<PrinterInfo>> DiscoverAsync() => Task.FromResult<IReadOnlyList<PrinterInfo>>([new("SIMULATED-ONLY", false, true, "SIMULATED", false)]);
    public async Task<PrintResult> SubmitPdfAsync(string queueName, string pdfPath, bool doubleSided = false) {
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

    public async Task<PrintResult> SubmitPdfAsync(string queueName, string pdfPath, bool doubleSided = false) {
        if (!OperatingSystem.IsWindows()) return new(false,"UNAVAILABLE",queueName,"Windows printer queues are available only on Windows.");
        if (!PrinterSettings.InstalledPrinters.Cast<string>().Any(name=>string.Equals(name,queueName,StringComparison.Ordinal))) return new(false,"UNAVAILABLE",queueName,"The exact assigned Windows printer queue is not installed; no fallback queue was used.");
        var settings = new PrinterSettings { PrinterName = queueName };
        if (!settings.IsValid) return new(false,"UNAVAILABLE",queueName,"The selected printer queue is not installed or available.");
        if (doubleSided && !settings.CanDuplex) return new(false,"FAILED",queueName,"The selected Windows driver does not report double-sided printing support.");
        var probe=ReadQueueStatus(queueName);
        if (!probe.Available) return new(false,"UNAVAILABLE",queueName,$"Windows spooler reports the queue unavailable ({probe.Status}).");
        if (!File.Exists(pdfPath)) return new(false,"FAILED",queueName,"File does not exist");
        var isDocx = pdfPath.EndsWith(".docx", StringComparison.OrdinalIgnoreCase);
        if (isDocx) {
            return await SubmitViaPrintToAsync(queueName, pdfPath, doubleSided);
        }
        var renderer = ResolvePdfRenderer();
        if (!string.IsNullOrWhiteSpace(renderer)) {
            var template = Environment.GetEnvironmentVariable("QRPRINT_PDF_PRINT_ARGS");
            string args;
            if (!string.IsNullOrWhiteSpace(template)) {
                if (doubleSided && !template.Contains("{duplex}", StringComparison.Ordinal)) return new(false,"FAILED",queueName,"Configure QRPRINT_PDF_PRINT_ARGS with a {duplex} placeholder so the requested single/double-sided mode is applied.");
                var duplex = doubleSided ? "duplexlong" : "simplex";
                args = template.Replace("{printer}", queueName).Replace("{file}", pdfPath).Replace("{duplex}", duplex);
            } else {
                args = doubleSided
                    ? $"-print-to \"{queueName}\" -print-settings \"duplexlong\" -silent \"{pdfPath}\""
                    : $"-print-to \"{queueName}\" -silent \"{pdfPath}\"";
            }
            Console.WriteLine($"Print command: {Path.GetFileName(renderer)} to queue '{queueName}' (args: {args}).");
            using var process = Process.Start(new ProcessStartInfo(renderer, args) { UseShellExecute=false, CreateNoWindow=true });
            if (process is null) return new(false,"FAILED",queueName,"PDF renderer did not start.");
            using var timeout=new CancellationTokenSource(TimeSpan.FromMinutes(2));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch(OperationCanceledException) {
                try { process.Kill(entireProcessTree:true); } catch {}
                Console.Error.WriteLine($"Print process timed out for queue '{queueName}'.");
                return new(false,"OUTCOME_UNKNOWN",queueName,"PDF renderer did not finish within two minutes; submission outcome is unknown.");
            }
            Console.WriteLine($"Print process exit code: {process.ExitCode}.");
            if (process.ExitCode != 0) return new(false,"FAILED",queueName,$"PDF renderer exited with code {process.ExitCode}.");
            Console.WriteLine($"Spooler submission accepted for queue '{queueName}'.");
            return new(true,"SPOOLER_ACCEPTED",queueName,"The configured renderer returned success and the queue was not marked unavailable. This does not confirm paper output.");
        }
        return await SubmitViaPrintToAsync(queueName, pdfPath, doubleSided);
    }

    internal static string? ResolvePdfRenderer() {
        var configured = Environment.GetEnvironmentVariable("QRPRINT_PDF_PRINT_COMMAND");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;
        string[] known = [
            Path.Combine(AppContext.BaseDirectory, "SumatraPDF.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SumatraPDF", "SumatraPDF.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "SumatraPDF", "SumatraPDF.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "SumatraPDF", "SumatraPDF.exe"),
        ];
        return Array.Find(known, File.Exists);
    }

    private static async Task<PrintResult> SubmitViaPrintToAsync(string queueName, string pdfPath, bool doubleSided) {
        var isDocx = pdfPath.EndsWith(".docx", StringComparison.OrdinalIgnoreCase);
        if (doubleSided && !isDocx) return new(false,"FAILED",queueName,"Double-sided printing needs a PDF renderer (install SumatraPDF or set QRPRINT_PDF_PRINT_COMMAND). Windows PrintTo cannot set duplex.");
        var info = new ProcessStartInfo {
            FileName = pdfPath,
            Verb = "PrintTo",
            Arguments = $"\"{queueName}\"",
            UseShellExecute = true,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            ErrorDialog = false,
        };
        if (!info.Verbs.Any(verb => verb.Equals("printto", StringComparison.OrdinalIgnoreCase)))
            return new(false,"UNAVAILABLE",queueName,isDocx ? "This PC has no PrintTo handler for DOCX files (Microsoft Word is required)." : "This PC has no PrintTo handler for PDF files. Install SumatraPDF or set QRPRINT_PDF_PRINT_COMMAND.");
        Console.WriteLine($"Print command: Windows PrintTo verb to queue '{queueName}' ({pdfPath}).");
        using var process = Process.Start(info);
        if (process is null) {
            Console.WriteLine("Spooler submission handed to PrintTo handler (no process handle).");
            return new(true,"SPOOLER_ACCEPTED",queueName,"Windows handed the document to the PrintTo handler. Physical output remains unconfirmed.");
        }
        using var timeout=new CancellationTokenSource(TimeSpan.FromMinutes(2));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch(OperationCanceledException) {
            Console.WriteLine("Print process still running after two minutes; treating spooler handoff as accepted.");
            return new(true,"SPOOLER_ACCEPTED",queueName,"Windows PrintTo was started. The handler is still running; physical output remains unconfirmed.");
        }
        Console.WriteLine($"Print process exit code: {process.ExitCode}.");
        Console.WriteLine($"Spooler submission completed for queue '{queueName}'.");
        return new(true,"SPOOLER_ACCEPTED",queueName,"Windows PrintTo completed. Physical output remains unconfirmed.");
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
            try {
                using var response=await api.PostStatusAsync(jobId,new {eventKey,status,leaseToken,error,externalJobId});
                var accepted=response.RootElement.TryGetProperty("status",out var reported)?reported.GetString():status;
                Console.WriteLine($"Job {jobId}: status-event API accepted {accepted} (attempt {attempt+1}).");
                return;
            }
            catch(Exception ex) when(attempt<3){last=ex;Console.Error.WriteLine($"Job {jobId}: status-event API failed for {status}: {ex.Message}; retrying.");await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2,attempt)));}
            catch(Exception ex){last=ex;}
        }
        throw new InvalidOperationException("Could not report agent job status; the lease will expire and submission outcome will be reconciled.",last);
    }

    private static async Task<LocalPrintJob> SetPendingResultAsync(LocalPrintJob entry,string status,string? error=null) {
        var updated=entry with {Stage="RESULT_PENDING",ResultStatus=status,ResultEventKey=entry.ResultEventKey??$"result-{Guid.NewGuid():N}",ResultError=error};
        await AgentLocalSpool.SaveAsync(updated);return updated;
    }

    private static bool IsResolved(JsonElement state) {
        var status=state.GetProperty("status").GetString();var physical=state.GetProperty("physicalStatus").GetString();
        return status == "SIMULATED_COMPLETE" || physical == "OUTPUT_CONFIRMED";
    }

    private static async Task SyncSpoolEntryAsync(AgentApiClient api,IPrinterAdapter adapter,LocalPrintJob entry) {
        JsonDocument response;
        try { response=await api.GetJobStateAsync(entry.Id,entry.LeaseToken); }
        catch(Exception ex){Console.Error.WriteLine($"Local job {entry.Id} retained; API is unavailable: {ex.Message}");return;}
        using(response){
            var state=response.RootElement;var status=state.GetProperty("status").GetString()??"";var leaseOwned=state.GetProperty("leaseOwned").GetBoolean();
            if(IsResolved(state)){await AgentLocalSpool.DeleteAsync(entry.ShopId,entry.Id);Console.WriteLine($"Local file for resolved job {entry.Id} was removed.");return;}
            // A requeued job may be claimed again; preserve its encrypted PDF across retries.
            if(status=="QUEUED")return;
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
                if(!leaseOwned||status is not("LEASED" or "DOWNLOADED")){if(status is "FAILED" or "CANCELLED" or "QUEUED")await AgentLocalSpool.DeleteAsync(entry.ShopId,entry.Id);return;}
                await SubmitDownloadedAsync(api,adapter,entry);
            }
        }
    }

    private static async Task SubmitDownloadedAsync(AgentApiClient api,IPrinterAdapter adapter,LocalPrintJob entry) {
        Console.WriteLine($"Preparing job {entry.Id} for exact printer queue '{entry.QueueName}'.");
        var available=(await adapter.DiscoverAsync()).Any(p=>p.Name.Equals(entry.QueueName,StringComparison.Ordinal)&&p.Available);
        if(entry.Mode=="REAL"&&!available){Console.Error.WriteLine($"Job {entry.Id} was not submitted: exact assigned queue '{entry.QueueName}' is missing or unavailable.");entry=await SetPendingResultAsync(entry,"FAILED","Assigned Windows queue is unavailable before submission; no print was attempted.");try{await ReportAsync(api,entry.Id,entry.LeaseToken,entry.ResultStatus!,entry.ResultEventKey!,entry.ResultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}catch(Exception ex){Console.Error.WriteLine($"Could not report queue-unavailable status for job {entry.Id}: {ex.Message}");}return;}
        var isDocx=entry.FileExtension.Equals("docx",StringComparison.OrdinalIgnoreCase);
        if(isDocx){
            var docxPrintTo=new ProcessStartInfo{FileName="job.docx",UseShellExecute=true}.Verbs.Any(verb=>verb.Equals("printto",StringComparison.OrdinalIgnoreCase));
            if(entry.Mode=="REAL"&&!docxPrintTo){var detail="This PC has no PrintTo handler for DOCX files (Microsoft Word is required for direct printing).";Console.Error.WriteLine($"Job {entry.Id} was not submitted: {detail}");entry=await SetPendingResultAsync(entry,"FAILED",detail);try{await ReportAsync(api,entry.Id,entry.LeaseToken,entry.ResultStatus!,entry.ResultEventKey!,entry.ResultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}catch(Exception ex){Console.Error.WriteLine($"Could not report DOCX configuration failure for job {entry.Id}: {ex.Message}");}return;}
        } else {
            var renderer=WindowsQueueAdapter.ResolvePdfRenderer();
            var printTo=new ProcessStartInfo{FileName="job.pdf",UseShellExecute=true}.Verbs.Any(verb=>verb.Equals("printto",StringComparison.OrdinalIgnoreCase));
            if(entry.Mode=="REAL"&&string.IsNullOrWhiteSpace(renderer)&&(entry.DoubleSided||!printTo)){var detail=entry.DoubleSided?"Double-sided printing needs SumatraPDF or QRPRINT_PDF_PRINT_COMMAND.":"Install SumatraPDF or set QRPRINT_PDF_PRINT_COMMAND; this PC has no PDF PrintTo handler.";Console.Error.WriteLine($"Job {entry.Id} was not submitted: {detail}");entry=await SetPendingResultAsync(entry,"FAILED",detail);try{await ReportAsync(api,entry.Id,entry.LeaseToken,entry.ResultStatus!,entry.ResultEventKey!,entry.ResultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);}catch(Exception ex){Console.Error.WriteLine($"Could not report renderer configuration failure for job {entry.Id}: {ex.Message}");}return;}
        }
        if(entry.Stage=="DOWNLOADED")entry=entry with{Stage="SUBMISSION_INTENT"};
        await AgentLocalSpool.SaveAsync(entry);
        try{await ReportAsync(api,entry.Id,entry.LeaseToken,"SUBMITTING",entry.SubmissionEventKey);}
        catch(Exception ex){Console.Error.WriteLine($"Job {entry.Id} is safely retained; submission was not attempted because the API did not acknowledge it: {ex.Message}");return;}
        entry=entry with{Stage="SUBMITTING"};await AgentLocalSpool.SaveAsync(entry);
        Console.WriteLine($"Submitting job {entry.Id} to Windows spooler queue '{entry.QueueName}'.");
        string resultStatus,resultError="";
        try{
            var submissionCopy=await AgentLocalSpool.CreateSubmissionCopyAsync(entry.ShopId,entry.Id,entry.FileExtension);
            PrintResult result;
            try { result=await adapter.SubmitPdfAsync(entry.QueueName,submissionCopy,entry.DoubleSided); }
            finally { await AgentLocalSpool.DeleteSubmissionCopyAsync(entry.ShopId,entry.Id,submissionCopy); }
            if(entry.Mode=="SIMULATED"&&result.Accepted)resultStatus="SIMULATED_COMPLETE";
            else if(entry.Mode=="REAL"&&result.Accepted)resultStatus="SPOOLER_ACCEPTED";
            else resultStatus="OUTCOME_UNKNOWN";
            resultError=result.Detail??"";
        }catch(Exception ex){resultStatus="OUTCOME_UNKNOWN";resultError=ex.Message.Length>450?ex.Message[..450]:ex.Message;}
        entry=await SetPendingResultAsync(entry,resultStatus,resultError);
        try{await ReportAsync(api,entry.Id,entry.LeaseToken,resultStatus,entry.ResultEventKey!,resultError);entry=entry with{Stage="RESULT_REPORTED"};await AgentLocalSpool.SaveAsync(entry);Console.WriteLine(resultStatus=="SIMULATED_COMPLETE"?"SIMULATED ONLY: no physical pages were printed.":resultStatus=="SPOOLER_ACCEPTED"?"Windows spooler accepted the command. Physical output remains unconfirmed.":$"Job {entry.Id} has an unknown outcome; do not resubmit it.");}
        catch(Exception ex){Console.Error.WriteLine($"Job result retained for retry after reconnection: {ex.Message}");}
    }

    private static async Task ProcessClaimedJobAsync(AgentApiClient api,IPrinterAdapter adapter,string shopId,string queueName,string mode,string id,string token) {
        var deliveryStage="loading print options";
        try {
            Console.WriteLine($"Job {id}: print-options request started.");
            using var options=await api.GetJobPrintOptionsAsync(id,token);
            var doubleSided=options.RootElement.GetProperty("doubleSided").GetBoolean();
            Console.WriteLine($"Job {id}: print-options completed; duplex={doubleSided}.");
            deliveryStage="downloading document";
            Console.WriteLine($"Job {id}: download started (GET agent/jobs/{id}/document, X-Job-Lease present, timeout {AgentDocument.DocumentTimeoutSeconds}s).");
            var downloaded=await api.DownloadAsync(id,token);
            Console.WriteLine($"Job {id}: download completed; type={downloaded.DocumentType}; http={downloaded.StatusCode}; contentType={downloaded.ContentType}; source={downloaded.Source}; bytes={downloaded.ByteCount}; origin={downloaded.StorageHost??"api"}; elapsedMs={downloaded.ElapsedMs}.");
            deliveryStage="validating local document";
            if(downloaded.DocumentType=="docx"){
                if(!AgentDocument.HasDocxMagic(downloaded.Bytes))throw new InvalidOperationException("Downloaded document failed DOCX magic validation.");
                Console.WriteLine($"Job {id}: local DOCX validation passed.");
            } else {
                if(!AgentDocument.HasPdfMagic(downloaded.Bytes))throw new InvalidOperationException("Downloaded document failed PDF magic validation.");
                Console.WriteLine($"Job {id}: local PDF validation passed.");
            }
            deliveryStage="saving encrypted local spool copy";
            var local=await AgentLocalSpool.SaveDownloadedAsync(shopId,id,token,mode,queueName,doubleSided,downloaded.Bytes,downloaded.DocumentType);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(downloaded.Bytes);
            Console.WriteLine($"Job {id}: encrypted spool saved.");
            deliveryStage="submitting to printer";
            await SyncSpoolEntryAsync(api,adapter,local);
        } catch(Exception ex) {
            var canceled=ex is OperationCanceledException or TaskCanceledException;
            Console.Error.WriteLine($"Job {id} failed during {deliveryStage}; {ex.GetType().Name}: {ex.Message}");
            if(canceled)Console.Error.WriteLine($"Job {id}: request canceled while waiting for document headers or body. No print was submitted.");
            var reported=await TryReportPreSubmissionFailureAsync(api,id,token,deliveryStage,ex);
            if(!reported)await WaitForLeaseReleaseAsync(api,id,token);
        }
    }

    private static async Task<bool> TryReportPreSubmissionFailureAsync(AgentApiClient api,string jobId,string leaseToken,string deliveryStage,Exception ex) {
        var detail=$"{deliveryStage}: {ex.GetType().Name}: {ex.Message}";
        if(detail.Length>450)detail=detail[..450];
        try {
            await ReportAsync(api,jobId,leaseToken,"FAILED",$"download-{Guid.NewGuid():N}",detail);
            Console.WriteLine($"Job {jobId}: pre-submission failure reported; not retrying print for this lease.");
            return true;
        } catch(Exception reportEx) {
            Console.Error.WriteLine($"Job {jobId}: could not report {deliveryStage} failure: {reportEx.Message}");
            return false;
        }
    }

    private static async Task WaitForLeaseReleaseAsync(AgentApiClient api,string jobId,string leaseToken) {
        Console.WriteLine($"Job {jobId}: waiting for lease release before claiming another job.");
        for(var i=0;i<18;i++){
            try {
                using var state=await api.GetJobStateAsync(jobId,leaseToken);
                var status=state.RootElement.GetProperty("status").GetString()??"";
                var owned=state.RootElement.GetProperty("leaseOwned").GetBoolean();
                Console.WriteLine($"Job {jobId}: state={status}; leaseOwned={owned}.");
                if(!owned||status is "QUEUED" or "FAILED" or "CANCELLED" or "SPOOLER_ACCEPTED" or "SIMULATED_COMPLETE" or "OUTCOME_UNKNOWN")return;
            } catch(Exception ex) {
                Console.Error.WriteLine($"Job {jobId}: lease poll failed: {ex.Message}");
            }
            await Task.Delay(TimeSpan.FromSeconds(5));
        }
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
            var shopId=device.GetProperty("shopId").GetString()??throw new InvalidOperationException("API heartbeat did not return the enrolled shop ID.");
            var mode=device.GetProperty("mode").GetString()??"";
            if(!mode.Equals(requestedMode,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException($"Enrolled agent mode is {mode}; configured mode is {requestedMode}. Re-enroll or configure the correct mode.");
            var printer=heartbeat.RootElement.GetProperty("printer");
            var queueName=printer.GetProperty("queueName").GetString()??"";
            IPrinterAdapter adapter=mode.Equals("REAL",StringComparison.OrdinalIgnoreCase)?new WindowsQueueAdapter():new SimulatedPrinterAdapter();
            Console.WriteLine($"Connected to QR Print API as {device.GetProperty("name").GetString()} ({mode}). Printer queue: {queueName}");
            PrinterInfo? reported=null;
            if(mode=="REAL"){
                reported=(await adapter.DiscoverAsync()).FirstOrDefault(p=>p.Name.Equals(queueName,StringComparison.Ordinal))??new PrinterInfo(queueName,false,false,"QUEUE_NOT_INSTALLED",false);
                using var observed=await api.PostAsync("agent/heartbeat",new {observedQueue=ToObservedQueue(reported)});
                if(!reported.Available)Console.Error.WriteLine($"UNAVAILABLE: assigned Windows queue '{queueName}' is not currently available. No print will be reported as successful.");
            } else {
                using var simulatedHeartbeat=await api.PostAsync("agent/heartbeat",new {ping=true});
                Console.WriteLine("SIMULATED ONLY: this agent will not inspect or access a Windows printer queue.");
            }
            keepAlive=Task.Run(async()=>{while(!stop.IsCancellationRequested){try{if(mode=="REAL"){var current=(await adapter.DiscoverAsync()).FirstOrDefault(p=>p.Name.Equals(queueName,StringComparison.Ordinal))??new PrinterInfo(queueName,false,false,"QUEUE_NOT_INSTALLED",false);using var h=await api.PostAsync("agent/heartbeat",new {observedQueue=ToObservedQueue(current)},stop.Token);Console.WriteLine($"Heartbeat accepted; assigned queue status: {current.Status}.");}else{using var h=await api.PostAsync("agent/heartbeat",new {ping=true},stop.Token);Console.WriteLine("Simulated heartbeat accepted; no Windows printer queue was accessed.");}}catch(OperationCanceledException) when(stop.IsCancellationRequested){break;}catch(Exception ex){Console.Error.WriteLine($"API heartbeat failed: {ex.Message}");}try{await Task.Delay(TimeSpan.FromSeconds(15),stop.Token);}catch(OperationCanceledException){break;}}});
            string? inFlightJobId=null;
            while(true){
                if(!AgentDocument.CanClaimNext(inFlightJobId)){Console.Error.WriteLine($"Refusing to claim another job while {inFlightJobId} is in flight.");await Task.Delay(TimeSpan.FromSeconds(5));continue;}
                foreach(var localJob in await AgentLocalSpool.LoadAllAsync(shopId))await SyncSpoolEntryAsync(api,adapter,localJob);
                JsonDocument claim;
                try { claim=await api.PostAsync("agent/jobs/claim",new {ping=true}); }
                catch(Exception ex){Console.Error.WriteLine($"Job claim failed; reconnecting in five seconds: {ex.Message}");await Task.Delay(TimeSpan.FromSeconds(5));continue;}
                using var claimDocument=claim;
                var job=claimDocument.RootElement.GetProperty("job");
                if(job.ValueKind==JsonValueKind.Null){var diagnostics=claimDocument.RootElement.TryGetProperty("diagnostics",out var details)?details:default;var reason=diagnostics.ValueKind==JsonValueKind.Object&&diagnostics.TryGetProperty("reasons",out var reasons)?reasons.ToString():"unavailable";var examples=diagnostics.ValueKind==JsonValueKind.Object&&diagnostics.TryGetProperty("examples",out var sample)?sample.ToString():"[]";Console.WriteLine($"No eligible queued job for agent printer '{queueName}' ({mode}); claim reasons: {reason}; examples: {examples}.");await Task.Delay(TimeSpan.FromSeconds(10));continue;}
                var id=job.GetProperty("id").GetString()!;var token=job.GetProperty("leaseToken").GetString()!;
                inFlightJobId=id;
                Console.WriteLine($"Claimed job {id} ({mode}); processing this job to submission or a reported failure before claiming another.");
                try { await ProcessClaimedJobAsync(api,adapter,shopId,queueName,mode,id,token); }
                finally { inFlightJobId=null; }
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
