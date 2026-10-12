using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace QRPrint.Agent;

public sealed class AgentApiClient : IDisposable {
    private readonly HttpClient client;
    public AgentApiClient(string baseUrl,string? credential=null) {
        client=new HttpClient { BaseAddress=new Uri(baseUrl.TrimEnd('/')+"/"),Timeout=TimeSpan.FromSeconds(25) };
        if(!string.IsNullOrWhiteSpace(credential))client.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",credential);
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }
    public async Task<JsonDocument> GetAsync(string route,CancellationToken ct=default) {
        using var response=await client.GetAsync(route,ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw CreateApiException(route,response.StatusCode,payload);
        return JsonDocument.Parse(payload);
    }
    public async Task<JsonDocument> PostAsync(string route,object body,CancellationToken ct=default) {
        using var response=await client.PostAsync(route,new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json"),ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw CreateApiException(route,response.StatusCode,payload);
        return JsonDocument.Parse(payload);
    }
    public async Task<JsonDocument> PutAsync(string route,object body,CancellationToken ct=default) {
        using var response=await client.PutAsync(route,new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json"),ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw CreateApiException(route,response.StatusCode,payload);
        return JsonDocument.Parse(payload);
    }
    public async Task<JsonDocument> GetJobStateAsync(string jobId,string leaseToken,CancellationToken ct=default) {
        using var request=new HttpRequestMessage(HttpMethod.Get,$"agent/jobs/{Uri.EscapeDataString(jobId)}/state");
        request.Headers.Add("X-Job-Lease",leaseToken);
        using var response=await client.SendAsync(request,ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw CreateApiException("agent job state",response.StatusCode,payload);
        return JsonDocument.Parse(payload);
    }
    public async Task<JsonDocument> GetJobPrintOptionsAsync(string jobId,string leaseToken,CancellationToken ct=default) {
        using var request=new HttpRequestMessage(HttpMethod.Get,$"agent/jobs/{Uri.EscapeDataString(jobId)}/print-options");
        request.Headers.Add("X-Job-Lease",leaseToken);
        using var response=await client.SendAsync(request,ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw CreateApiException("agent print options",response.StatusCode,payload);
        return JsonDocument.Parse(payload);
    }
    public async Task<byte[]> DownloadAsync(string jobId,string leaseToken,CancellationToken ct=default) {
        using var request=new HttpRequestMessage(HttpMethod.Get,$"agent/jobs/{Uri.EscapeDataString(jobId)}/document");
        request.Headers.Add("X-Job-Lease",leaseToken);
        using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);
        if(!response.IsSuccessStatusCode)throw CreateApiException("agent document download",response.StatusCode,await response.Content.ReadAsStringAsync(ct));
        if(response.Content.Headers.ContentType?.MediaType?.Equals("application/json",StringComparison.OrdinalIgnoreCase)==true){
            using var payload=JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var uri=new Uri(payload.RootElement.GetProperty("downloadUrl").GetString()??throw new InvalidOperationException("API did not return a document URL."));
            if(uri.Scheme!="https")throw new InvalidOperationException("Private document URL must use HTTPS.");
            // Use an unauthenticated client: the agent bearer token is scoped to the API and must never be sent to Blob.
            using var storageClient=new HttpClient{Timeout=TimeSpan.FromMinutes(2)};
            using var download=await storageClient.GetAsync(uri,HttpCompletionOption.ResponseHeadersRead,ct);
            if(!download.IsSuccessStatusCode)throw new HttpRequestException($"Private document download returned {(int)download.StatusCode}.");
            return await download.Content.ReadAsByteArrayAsync(ct);
        }
        return await response.Content.ReadAsByteArrayAsync(ct);
    }
    public async Task<byte[]> GetBytesAsync(string route,CancellationToken ct=default) {
        using var response=await client.GetAsync(route,HttpCompletionOption.ResponseHeadersRead,ct);
        if(!response.IsSuccessStatusCode)throw CreateApiException(route,response.StatusCode,await response.Content.ReadAsStringAsync(ct));
        return await response.Content.ReadAsByteArrayAsync(ct);
    }
    private static HttpRequestException CreateApiException(string route,System.Net.HttpStatusCode status,string payload) {
        var message="Request failed.";
        try {
            using var document=JsonDocument.Parse(payload);
            if(document.RootElement.ValueKind==JsonValueKind.Object&&document.RootElement.TryGetProperty("error",out var error)) {
                if(error.ValueKind==JsonValueKind.Object) {
                    if(error.TryGetProperty("message",out var text)&&text.ValueKind==JsonValueKind.String)message=text.GetString()??message;
                    if(error.TryGetProperty("details",out var details)&&details.ValueKind==JsonValueKind.Array) {
                        var issues=details.EnumerateArray().Select(issue=>{
                            var field=issue.TryGetProperty("field",out var fieldValue)?fieldValue.GetString():null;
                            var reason=issue.TryGetProperty("message",out var reasonValue)?reasonValue.GetString():null;
                            return string.IsNullOrWhiteSpace(field)?reason:$"{field}: {reason}";
                        }).Where(issue=>!string.IsNullOrWhiteSpace(issue));
                        var summary=string.Join("; ",issues);
                        if(summary.Length>500)summary=summary[..500];
                        if(summary.Length>0)message=$"{message} {summary}";
                    }
                } else if(error.ValueKind==JsonValueKind.String)message=error.GetString()??message;
            }
        } catch(JsonException) {
            message="The API returned an unreadable error response.";
        }
        return new HttpRequestException($"API {route} returned {(int)status}: {message}");
    }
    public void Dispose()=>client.Dispose();
}
