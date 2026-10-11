namespace QRPrint.Agent;

public static class AgentOnboarding {
    public static Task RunAsync() {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("Shop onboarding requires Windows.");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new OnboardingWizardForm());
        return Task.CompletedTask;
    }
}
