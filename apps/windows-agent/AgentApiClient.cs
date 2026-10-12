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
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"API {route} returned {(int)response.StatusCode}: {payload}");
        return JsonDocument.Parse(payload);
    }
    public async Task<JsonDocument> PostAsync(string route,object body,CancellationToken ct=default) {
        using var response=await client.PostAsync(route,new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json"),ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"API {route} returned {(int)response.StatusCode}: {payload}");
        return JsonDocument.Parse(payload);
    }
    public async Task<JsonDocument> PutAsync(string route,object body,CancellationToken ct=default) {
        using var response=await client.PutAsync(route,new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json"),ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"API {route} returned {(int)response.StatusCode}: {payload}");
        return JsonDocument.Parse(payload);
    }
    public async Task<JsonDocument> GetJobStateAsync(string jobId,string leaseToken,CancellationToken ct=default) {
        using var request=new HttpRequestMessage(HttpMethod.Get,$"agent/jobs/{Uri.EscapeDataString(jobId)}/state");
        request.Headers.Add("X-Job-Lease",leaseToken);
        using var response=await client.SendAsync(request,ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"Job state request returned {(int)response.StatusCode}: {payload}");
        return JsonDocument.Parse(payload);
    }
    public async Task<JsonDocument> GetJobPrintOptionsAsync(string jobId,string leaseToken,CancellationToken ct=default) {
        using var request=new HttpRequestMessage(HttpMethod.Get,$"agent/jobs/{Uri.EscapeDataString(jobId)}/print-options");
        request.Headers.Add("X-Job-Lease",leaseToken);
        using var response=await client.SendAsync(request,ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"Print options request returned {(int)response.StatusCode}: {payload}");
        return JsonDocument.Parse(payload);
    }
    public async Task<byte[]> DownloadAsync(string jobId,string leaseToken,CancellationToken ct=default) {
        using var request=new HttpRequestMessage(HttpMethod.Get,$"agent/jobs/{Uri.EscapeDataString(jobId)}/document");
        request.Headers.Add("X-Job-Lease",leaseToken);
        using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"Document download returned {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(ct)}");
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
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"API {route} returned {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(ct)}");
        return await response.Content.ReadAsByteArrayAsync(ct);
    }
    public void Dispose()=>client.Dispose();
}
