using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Win32;

namespace QRPrint.Agent;

public sealed class OnboardingWizardForm : Form {
    private const string StartupValue="QRPrintShopAgent";
    private readonly TextBox apiUrl=new(){Text=Environment.GetEnvironmentVariable("QRPRINT_API_URL")??"https://api.example.com",Dock=DockStyle.Fill};
    private readonly TextBox email=new(){Dock=DockStyle.Fill};
    private readonly TextBox password=new(){UseSystemPasswordChar=true,Dock=DockStyle.Fill};
    private readonly TextBox shopName=new(){Dock=DockStyle.Fill};
    private readonly TextBox shopSlug=new(){Dock=DockStyle.Fill};
    private readonly ComboBox shops=new(){DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill};
    private readonly ComboBox queues=new(){DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill};
    private readonly Label capabilities=new(){AutoSize=true,ForeColor=Color.FromArgb(72,91,105),MaximumSize=new Size(650,0)};
    private readonly Label status=new(){AutoSize=true,ForeColor=Color.FromArgb(17,103,91),MaximumSize=new Size(650,0)};
    private readonly Button signIn=new(){Text="Sign in and discover printers",AutoSize=true};
    private readonly Button rescan=new(){Text="Rescan installed queues",AutoSize=true,Enabled=false};
    private readonly Button setup=new(){Text="Connect shop and create QR",AutoSize=true,Enabled=false};
    private readonly CheckBox startOnLogin=new(){Text="Start the print agent when this Windows user signs in",AutoSize=true};
    private AgentApiClient? ownerApi;
    private string? ownerToken;
    private string mode="";
    private PrinterInfo[] discovered=[];
    private bool signedIn;

    public OnboardingWizardForm() {
        Text="QR Print | Shop setup";StartPosition=FormStartPosition.CenterScreen;MinimumSize=new Size(780,690);Size=new Size(860,760);BackColor=Color.FromArgb(244,247,250);Font=new Font("Segoe UI",10);Icon=null;
        var root=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(28),ColumnCount=1,RowCount=4};root.RowStyles.Add(new RowStyle(SizeType.AutoSize));root.RowStyles.Add(new RowStyle(SizeType.AutoSize));root.RowStyles.Add(new RowStyle(SizeType.Percent,100));root.RowStyles.Add(new RowStyle(SizeType.AutoSize));Controls.Add(root);
        root.Controls.Add(new Label{Text="Set up your print shop",AutoSize=true,Font=new Font("Segoe UI Semibold",22,FontStyle.Bold),ForeColor=Color.FromArgb(16,34,53),Margin=new Padding(0,0,0,4)},0,0);
        root.Controls.Add(new Label{Text="Connect an owner account, choose a Windows printer queue, and generate a public shop QR. Device credentials are protected for this Windows user.",AutoSize=true,MaximumSize=new Size(760,0),ForeColor=Color.FromArgb(72,91,105),Margin=new Padding(0,0,0,20)},0,1);
        var card=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(22),BackColor=Color.White,ColumnCount=2,AutoScroll=true};card.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,180));card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));root.Controls.Add(card,0,2);
        AddSection(card,"1. QR Print server",true);AddRow(card,"API HTTPS address",apiUrl);AddRow(card,"Owner email",email);AddRow(card,"Owner password",password);AddRow(card,"",SignInButtons());
        AddSection(card,"2. Select shop",true);AddRow(card,"Existing shop",shops);AddRow(card,"New shop name",shopName);AddRow(card,"New shop URL slug",shopSlug);
        AddSection(card,"3. Printer queue",true);AddRow(card,"Installed queue",queues);AddRow(card,"Driver-reported details",capabilities);AddRow(card,"",rescan);AddRow(card,"",startOnLogin);
        var footer=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(0,16,0,0)};footer.Controls.Add(status);footer.Controls.Add(setup);root.Controls.Add(footer,0,3);
        shops.Items.Add(new ShopOption(null,null,"Create a new shop"));shops.SelectedIndex=0;shops.SelectedIndexChanged+=(_,_)=>{SetShopFields();UpdateSetupEnabled();};queues.SelectedIndexChanged+=(_,_)=>{ShowCapabilities();UpdateSetupEnabled();};shopName.TextChanged+=(_,_)=>UpdateSetupEnabled();shopSlug.TextChanged+=(_,_)=>UpdateSetupEnabled();signIn.Click+=async(_,_)=>await SignInAndDiscoverAsync();rescan.Click+=async(_,_)=>await DiscoverQueuesAsync();setup.Click+=async(_,_)=>await CompleteSetupAsync();
        startOnLogin.Checked=HasStartupEntry();SetShopFields();
    }

    private static Control SignInButtons(){return new Label{Text="A platform administrator must provision a SHOP_OWNER account first. This wizard can create or connect shops owned by that account.",AutoSize=true,MaximumSize=new Size(610,0),ForeColor=Color.FromArgb(72,91,105)};}
    private static void AddSection(TableLayoutPanel grid,string title,bool spanning){var label=new Label{Text=title,AutoSize=true,Font=new Font("Segoe UI Semibold",12,FontStyle.Bold),ForeColor=Color.FromArgb(16,34,53),Margin=new Padding(0,16,0,8)};grid.Controls.Add(label,0,grid.RowCount);grid.SetColumnSpan(label,2);grid.RowCount++;grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));}
    private static void AddRow(TableLayoutPanel grid,string title,Control control){var row=grid.RowCount;grid.RowCount++;grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));grid.Controls.Add(new Label{Text=title,AutoSize=true,Anchor=AnchorStyles.Left,ForeColor=Color.FromArgb(45,65,78),Margin=new Padding(0,9,10,9)},0,row);control.Margin=new Padding(0,4,0,4);grid.Controls.Add(control,1,row);}

    private void SetShopFields(){var create=shops.SelectedItem is ShopOption option&&option.Id is null;shopName.Enabled=create;shopSlug.Enabled=create;}
    private void ShowCapabilities(){if(queues.SelectedItem is not QueueOption selected){capabilities.Text="Sign in to discover queues. Capabilities come only from the installed Windows driver.";return;}var c=selected.Printer.Capabilities;if(c is null){capabilities.Text=selected.Printer.Status+". No hardware capabilities are being claimed.";return;}capabilities.Text=$"Availability: {selected.Printer.Status}\r\nColor: {(c.SupportsColor?"driver reports supported":"driver does not report support")} · Duplex: {(c.CanDuplex?"driver reports supported":"driver does not report support")}\r\nPaper sizes: {string.Join(", ",c.PaperSizes)}\r\nResolutions: {string.Join(", ",c.Resolutions)}\r\nSource: {c.Source}";}

    private async Task SignInAndDiscoverAsync(){signIn.Enabled=false;status.Text="Connecting securely and checking shop access…";try{
        var baseUrl=apiUrl.Text.Trim();if(!Uri.TryCreate(baseUrl,UriKind.Absolute,out var uri)||!SafeUrl(uri))throw new InvalidOperationException("Use a public HTTPS API address. HTTP is allowed only for localhost development.");
        ownerApi?.Dispose();ownerApi=new AgentApiClient(baseUrl);using var login=await ownerApi.PostAsync("auth/login",new{email=email.Text.Trim(),password=password.Text});if(login.RootElement.GetProperty("role").GetString()!="SHOP_OWNER")throw new InvalidOperationException("This account is not a shop owner. Ask the platform administrator to provision a SHOP_OWNER account.");ownerToken=login.RootElement.GetProperty("token").GetString();password.Clear();if(string.IsNullOrWhiteSpace(ownerToken))throw new InvalidOperationException("Owner login did not return a session token.");ownerApi.Dispose();ownerApi=new AgentApiClient(baseUrl,ownerToken);
        using var health=await ownerApi.GetAsync("health");mode=(health.RootElement.GetProperty("executionMode").GetString()??"").ToUpperInvariant();if(mode is not("REAL" or "SIMULATED"))throw new InvalidOperationException("The API did not return a supported execution mode.");
        using var shopsResponse=await ownerApi.GetAsync("owner/shops");shops.Items.Clear();shops.Items.Add(new ShopOption(null,null,"Create a new shop"));foreach(var item in shopsResponse.RootElement.EnumerateArray()){var slug=item.GetProperty("slug").GetString()??"";shops.Items.Add(new ShopOption(item.GetProperty("id").GetString(),slug,$"{item.GetProperty("name").GetString()} (/{slug})"));}shops.SelectedIndex=0;
        signedIn=true;rescan.Enabled=true;await DiscoverQueuesAsync();status.Text=$"Signed in. Server print mode: {mode}. Select an existing shop or create one.";
    }catch(Exception ex){status.Text=ex.Message;}finally{signIn.Enabled=true;UpdateSetupEnabled();}}

    private async Task DiscoverQueuesAsync(){try{rescan.Enabled=false;queues.Items.Clear();discovered=(await new WindowsQueueAdapter().DiscoverAsync()).Where(p=>p.InstalledQueue).OrderBy(p=>p.Name,StringComparer.OrdinalIgnoreCase).ToArray();if(mode=="SIMULATED")queues.Items.Add(new QueueOption(new PrinterInfo("SIMULATED-ONLY",false,false,"SIMULATED_ONLY",false),"SIMULATED-ONLY — no Windows queue access"));foreach(var printer in discovered)queues.Items.Add(new QueueOption(printer,$"{printer.Name} — {printer.Status}"));if(queues.Items.Count>0)queues.SelectedIndex=0;ShowCapabilities();if(mode=="REAL"&&discovered.Length==0)status.Text="No installed Windows queue found. Install a driver/queue before real enrollment; nothing has been printed.";else if(discovered.Length==0&&mode=="SIMULATED")status.Text="No printer queue was found. The SIMULATED-ONLY virtual queue is available.";}catch(Exception ex){status.Text=$"Queue discovery failed: {ex.Message}";}finally{rescan.Enabled=signedIn;UpdateSetupEnabled();}}

    private void UpdateSetupEnabled(){setup.Enabled=signedIn&&ownerApi is not null&&queues.SelectedItem is QueueOption&&((shops.SelectedItem is ShopOption selected&&selected.Id is not null)||(shopName.Text.Trim().Length>=2&&System.Text.RegularExpressions.Regex.IsMatch(shopSlug.Text.Trim(),"^[a-z0-9-]+$")));}

    private async Task CompleteSetupAsync(){setup.Enabled=false;try{
        if(ownerApi is null)throw new InvalidOperationException("Sign in before continuing.");if(queues.SelectedItem is not QueueOption queue)throw new InvalidOperationException("Select a printer queue.");
        string shopId;string shopLabel;var shopOption=(ShopOption)shops.SelectedItem!;
        if(shopOption.Id is null){using var created=await ownerApi.PostAsync("shops",new{name=shopName.Text.Trim(),slug=shopSlug.Text.Trim()});shopId=created.RootElement.GetProperty("id").GetString()??throw new InvalidOperationException("Shop creation returned no ID.");shopLabel=shopName.Text.Trim();}
        else{shopId=shopOption.Id;shopLabel=shopOption.Label;}
        var printer=queue.Printer;var cap=printer.Capabilities;var isVirtual=printer.Name=="SIMULATED-ONLY";
        using var registeredPrinters=await ownerApi.GetAsync($"shops/{Uri.EscapeDataString(shopId)}/printers");var existingPrinter=registeredPrinters.RootElement.EnumerateArray().FirstOrDefault(p=>string.Equals(p.GetProperty("queueName").GetString(),printer.Name,StringComparison.OrdinalIgnoreCase));string printerId;
        if(existingPrinter.ValueKind==System.Text.Json.JsonValueKind.Object)printerId=existingPrinter.GetProperty("id").GetString()??throw new InvalidOperationException("Existing printer record returned no ID.");
        else{using var printerResponse=await ownerApi.PostAsync($"shops/{Uri.EscapeDataString(shopId)}/printers",new{name=printer.Name,queueName=printer.Name,connectionType=isVirtual?"SIMULATED":"WINDOWS_QUEUE",status=isVirtual?"SIMULATED_ONLY":printer.Available?$"AVAILABLE:{printer.Status}":$"UNAVAILABLE:{printer.Status}",capabilities=cap is null?null:new{source=cap.Source,supportsColor=cap.SupportsColor,canDuplex=cap.CanDuplex,paperSizes=cap.PaperSizes,resolutions=cap.Resolutions}});printerId=printerResponse.RootElement.GetProperty("id").GetString()??throw new InvalidOperationException("Printer registration returned no ID.");}
        using var agent=await ownerApi.PostAsync($"shops/{Uri.EscapeDataString(shopId)}/agents",new{name=Environment.MachineName,printerId,mode});var credential=agent.RootElement.GetProperty("credential").GetString()??throw new InvalidOperationException("Device enrollment returned no credential.");await AgentLocalSettings.SaveAsync(new AgentSettings(apiUrl.Text.Trim(),mode),credential);SetStartupEntry(startOnLogin.Checked);
        var slugValue=shopOption.Id is null?shopSlug.Text.Trim():shopOption.Slug??"shop";var qrPath="";try{var bytes=await ownerApi.GetBytesAsync($"shops/{Uri.EscapeDataString(slugValue)}/qr.svg");var folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),"QRPrint");Directory.CreateDirectory(folder);qrPath=Path.Combine(folder,$"{slugValue}-shop-qr.svg");await File.WriteAllBytesAsync(qrPath,bytes);}catch(Exception ex){status.Text=$"Shop and device enrolled; QR download unavailable: {ex.Message}. Configure the public app URL and download the QR from the owner panel.";}
        setup.Text="Connected";setup.Enabled=false;status.Text=$"Setup complete for {shopLabel}. Device credential protected with Windows DPAPI.{(qrPath.Length>0?$" QR saved to {qrPath}.":"")} No print was attempted.";
        var start=MessageBox.Show(this,"Shop setup is complete. Start the QR Print agent now?", "QR Print setup",MessageBoxButtons.YesNo,MessageBoxIcon.Information);if(start==DialogResult.Yes)StartAgent();
    }catch(Exception ex){status.Text=$"Setup failed: {ex.Message}";UpdateSetupEnabled();}}

    private bool HasStartupEntry(){try{using var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",false);var existing=key?.GetValue(StartupValue) as string;return !string.IsNullOrWhiteSpace(existing);}catch{return false;}}
    private static void SetStartupEntry(bool enabled){var executable=Environment.ProcessPath;if(string.IsNullOrWhiteSpace(executable))return;using var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",true);if(enabled)key?.SetValue(StartupValue,$"\"{executable}\"");else key?.DeleteValue(StartupValue,false);}
    private void StartAgent(){var executable=Environment.ProcessPath;if(!string.IsNullOrWhiteSpace(executable))Process.Start(new ProcessStartInfo(executable){UseShellExecute=true});}
    private static bool SafeUrl(Uri uri){var local=uri.IsLoopback||uri.Host.Equals("localhost",StringComparison.OrdinalIgnoreCase);return (uri.Scheme==Uri.UriSchemeHttps||local&&uri.Scheme==Uri.UriSchemeHttp)&&string.IsNullOrEmpty(uri.UserInfo);}
    protected override void Dispose(bool disposing){if(disposing)ownerApi?.Dispose();base.Dispose(disposing);}
    private sealed record ShopOption(string? Id,string? Slug,string Label){public override string ToString()=>Label;}
    private sealed record QueueOption(PrinterInfo Printer,string Label){public override string ToString()=>Label;}
}
