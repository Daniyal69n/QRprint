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
    public async Task<JsonDocument> GetJobStateAsync(string jobId,string leaseToken,CancellationToken ct=default) {
        using var request=new HttpRequestMessage(HttpMethod.Get,$"agent/jobs/{Uri.EscapeDataString(jobId)}/state");
        request.Headers.Add("X-Job-Lease",leaseToken);
        using var response=await client.SendAsync(request,ct);
        var payload=await response.Content.ReadAsStringAsync(ct);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"Job state request returned {(int)response.StatusCode}: {payload}");
        return JsonDocument.Parse(payload);
    }
    public async Task<byte[]> DownloadAsync(string jobId,string leaseToken,CancellationToken ct=default) {
        using var request=new HttpRequestMessage(HttpMethod.Get,$"agent/jobs/{Uri.EscapeDataString(jobId)}/document");
        request.Headers.Add("X-Job-Lease",leaseToken);
        using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"Document download returned {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(ct)}");
        return await response.Content.ReadAsByteArrayAsync(ct);
    }
    public async Task<byte[]> GetBytesAsync(string route,CancellationToken ct=default) {
        using var response=await client.GetAsync(route,HttpCompletionOption.ResponseHeadersRead,ct);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException($"API {route} returned {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(ct)}");
        return await response.Content.ReadAsByteArrayAsync(ct);
    }
    public void Dispose()=>client.Dispose();
}
