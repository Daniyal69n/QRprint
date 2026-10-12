using Xunit;

namespace QRPrint.Agent.Tests;

public class AgentDocumentTests {
    [Fact]
    public void PdfMagicRejectsEmptyOrJsonBodies() {
        Assert.False(AgentDocument.HasPdfMagic([]));
        Assert.False(AgentDocument.HasPdfMagic("{}"u8));
        Assert.True(AgentDocument.HasPdfMagic("%PDF-1.7"u8.ToArray()));
    }

    [Fact]
    public void SignedBlobUrlsAreLoggedWithoutQueryTokens() {
        var described=AgentDocument.DescribeOrigin("https://blob.vercel-storage.com/agent-jobs/cmv55r70w0007jk06ig06lut9.pdf?payload=secret-token");
        Assert.Equal("https://blob.vercel-storage.com", described);
        Assert.False(AgentDocument.ContainsSecretQuery(described));
    }

    [Fact]
    public void DocumentTimeoutExceedsThePreviousTwentyFiveSecondClientLimit() {
        Assert.True(AgentDocument.DocumentTimeoutSeconds >= 120);
        Assert.Equal(TimeSpan.FromSeconds(AgentDocument.DocumentTimeoutSeconds), AgentApiClient.DocumentTimeout);
    }

    [Fact]
    public void AnotherJobCannotBeClaimedWhileOneIsInFlight() {
        Assert.False(AgentDocument.CanClaimNext("cmv55ru6s000vjs06wf0nbzyi"));
        Assert.True(AgentDocument.CanClaimNext(null));
        Assert.True(AgentDocument.CanClaimNextAfter("FAILED_REPORTED"));
        Assert.False(AgentDocument.CanClaimNextAfter("IN_FLIGHT"));
    }
}
