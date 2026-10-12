using System.Diagnostics;
using System.Drawing;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

namespace QRPrint.Agent;

public sealed class OnboardingWizardForm : Form {
    private const string StartupValue="QRPrintShopAgent";
    private readonly TextBox apiUrl=new(){Text=Environment.GetEnvironmentVariable("QRPRINT_API_URL")??"https://qrprint-orcin.vercel.app/api",Dock=DockStyle.Fill};
    private readonly TextBox ownerName=new(){Dock=DockStyle.Fill};
    private readonly TextBox email=new(){Dock=DockStyle.Fill};
    private readonly TextBox password=new(){Dock=DockStyle.Fill,UseSystemPasswordChar=true};
    private readonly TextBox shopName=new(){Dock=DockStyle.Fill};
    private readonly TextBox shopSlug=new(){Dock=DockStyle.Fill};
    private readonly RadioButton createAccount=new(){Text="Create a new shop-owner account",Checked=true,AutoSize=true};
    private readonly RadioButton existingAccount=new(){Text="Sign in to an existing shop-owner account",AutoSize=true};
    private readonly ComboBox shops=new(){DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill};
    private readonly ComboBox queues=new(){DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill};
    private readonly CheckBox duplex=new(){Text="Offer double-sided printing to customers",AutoSize=true,Enabled=false};
    private readonly CheckBox startOnLogin=new(){Text="Start the print agent when this Windows user signs in",AutoSize=true};
    private readonly Label capabilities=new(){AutoSize=true,ForeColor=Color.FromArgb(72,91,105),MaximumSize=new Size(650,0)};
    private readonly Label status=new(){AutoSize=true,ForeColor=Color.FromArgb(17,103,91),MaximumSize=new Size(650,0)};
    private readonly Label success=new(){AutoSize=true,ForeColor=Color.FromArgb(16,34,53),Font=new Font("Segoe UI Semibold",12,FontStyle.Bold),MaximumSize=new Size(650,0),Visible=false};
    private readonly Button connect=new(){Text="Create account and shop",AutoSize=true};
    private readonly Button rescan=new(){Text="Rescan installed queues",AutoSize=true,Enabled=false};
    private readonly Button setup=new(){Text="Finish shop setup and create QR",AutoSize=true,Enabled=false};
    private readonly Button downloadQr=new(){Text="Download shop QR code",AutoSize=true,Visible=false};
    private readonly PictureBox qrPreview=new(){Width=220,Height=220,SizeMode=PictureBoxSizeMode.Zoom,BackColor=Color.White,Visible=false};
    private AgentApiClient? ownerApi;
    private string mode="";
    private string? completedShopSlug;
    private bool signedIn;

    public OnboardingWizardForm() {
        Text="QR Print | Shop setup";StartPosition=FormStartPosition.CenterScreen;MinimumSize=new Size(720,560);Size=new Size(820,680);BackColor=Color.FromArgb(244,247,250);Font=new Font("Segoe UI",10);Icon=null;
        var root=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(20),ColumnCount=1,RowCount=3};
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));root.RowStyles.Add(new RowStyle(SizeType.AutoSize));root.RowStyles.Add(new RowStyle(SizeType.Percent,100));Controls.Add(root);
        root.Controls.Add(new Label{Text="Set up your print shop",AutoSize=true,Font=new Font("Segoe UI Semibold",22,FontStyle.Bold),ForeColor=Color.FromArgb(16,34,53),Margin=new Padding(0,0,0,4)},0,0);
        root.Controls.Add(new Label{Text="Create or sign in to a shop-owner account, connect a Windows printer if available, and generate your shop's public QR code. Agent credentials are protected with Windows DPAPI.",AutoSize=true,MaximumSize=new Size(760,0),ForeColor=Color.FromArgb(72,91,105),Margin=new Padding(0,0,0,20)},0,1);
        var card=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(22),BackColor=Color.White,ColumnCount=2,AutoScroll=true};
        card.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,190));card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));root.Controls.Add(card,0,2);
        AddSection(card,"1. QR Print API");AddRow(card,"API HTTPS address",apiUrl);
        AddSection(card,"2. Shop-owner account");
        var accountChoice=new FlowLayoutPanel{AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false,Dock=DockStyle.Fill};
        accountChoice.Controls.Add(createAccount);accountChoice.Controls.Add(existingAccount);AddRow(card,"Choose an option",accountChoice);
        AddRow(card,"Owner name",ownerName);AddRow(card,"Email",email);AddRow(card,"Password",password);AddRow(card,"",new Label{Text="Use at least 12 characters. Maximum length is 72 UTF-8 bytes.",AutoSize=true,MaximumSize=new Size(560,0),ForeColor=Color.FromArgb(72,91,105)});
        AddRow(card,"",connect);
        AddSection(card,"3. Shop and printer");
        AddRow(card,"Shop URL slug tip",new Label{Text="Use lowercase letters, numbers, and hyphens. For example, “Elite” becomes “elite”.",AutoSize=true,MaximumSize=new Size(560,0),ForeColor=Color.FromArgb(72,91,105)});
        AddRow(card,"Shop",shops);AddRow(card,"New shop name",shopName);AddRow(card,"New shop URL slug",shopSlug);
        AddRow(card,"Installed printer queue",queues);AddRow(card,"Driver-reported details",capabilities);AddRow(card,"",duplex);AddRow(card,"",rescan);AddRow(card,"",startOnLogin);
        var footer=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(0,16,0,0)};
        footer.Controls.Add(status);footer.Controls.Add(setup);footer.Controls.Add(success);footer.Controls.Add(qrPreview);
        var qrActions=new FlowLayoutPanel{AutoSize=true,FlowDirection=FlowDirection.LeftToRight,WrapContents=false};qrActions.Controls.Add(downloadQr);footer.Controls.Add(qrActions);
        var footerRow=card.RowCount++;card.RowStyles.Add(new RowStyle(SizeType.AutoSize));card.Controls.Add(footer,0,footerRow);card.SetColumnSpan(footer,2);

        shops.Items.Add(new ShopOption(null,null,"","Create a new shop"));shops.SelectedIndex=0;
        shops.SelectedIndexChanged+=(_,_)=>{SetShopFields();UpdateSetupEnabled();};
        queues.SelectedIndexChanged+=(_,_)=>{ShowCapabilities();UpdateSetupEnabled();};
        shopName.TextChanged+=(_,_)=>UpdateSetupEnabled();shopSlug.TextChanged+=(_,_)=>UpdateSetupEnabled();
        createAccount.CheckedChanged+=(_,_)=>UpdateAccountFields();
        existingAccount.CheckedChanged+=(_,_)=>UpdateAccountFields();
        shopSlug.Leave+=(_,_)=>NormalizeShopSlug();
        connect.Click+=async(_,_)=>await ConnectOwnerAsync();
        rescan.Click+=async(_,_)=>await DiscoverQueuesAsync();
        setup.Click+=async(_,_)=>await CompleteSetupAsync();
        downloadQr.Click+=(_,_)=>DownloadQr();
        startOnLogin.Checked=HasStartupEntry();SetShopFields();UpdateAccountFields();
    }

    private static void AddSection(TableLayoutPanel grid,string title) {
        var label=new Label{Text=title,AutoSize=true,Font=new Font("Segoe UI Semibold",12,FontStyle.Bold),ForeColor=Color.FromArgb(16,34,53),Margin=new Padding(0,16,0,8)};
        grid.Controls.Add(label,0,grid.RowCount);grid.SetColumnSpan(label,2);grid.RowCount++;grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    }

    private static void AddRow(TableLayoutPanel grid,string title,Control control) {
        var row=grid.RowCount++;grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        grid.Controls.Add(new Label{Text=title,AutoSize=true,Anchor=AnchorStyles.Left,ForeColor=Color.FromArgb(45,65,78),Margin=new Padding(0,9,10,9)},0,row);
        control.Margin=new Padding(0,4,0,4);grid.Controls.Add(control,1,row);
    }

    private void UpdateAccountFields() {
        var creating=createAccount.Checked;
        ownerName.Enabled=creating&&!signedIn;
        ownerName.Visible=creating;SetRowLabelVisible(ownerName,creating);
        SetShopFields();
        connect.Text=creating?"Create owner account and shop":"Sign in and discover printers";
        UpdateSetupEnabled();
    }

    private static void SetRowLabelVisible(Control control,bool visible) {
        if(control.Parent is not TableLayoutPanel grid)return;
        var position=grid.GetPositionFromControl(control);
        foreach(Control sibling in grid.Controls)if(grid.GetPositionFromControl(sibling).Row==position.Row&&sibling!=control)sibling.Visible=visible;
    }

    private void SetShopFields() {
        var create=shops.SelectedItem is ShopOption option&&option.Id is null;
        var showFields=create&&(createAccount.Checked||signedIn);
        shopName.Enabled=showFields;
        shopSlug.Enabled=showFields;
        SetRowLabelVisible(shopName,showFields);
        SetRowLabelVisible(shopSlug,showFields);
    }

    private void ShowCapabilities() {
        if(queues.SelectedItem is not QueueOption selected) {
            capabilities.Text="No installed printer queue is selected. You can still create the shop and QR code; printer enrollment can be completed later.";
            duplex.Enabled=false;duplex.Checked=false;return;
        }
        var c=selected.Printer.Capabilities;
        if(c is null) {
            capabilities.Text=selected.Printer.Status+". The installed driver did not report hardware capabilities.";
            duplex.Enabled=false;duplex.Checked=false;return;
        }
        duplex.Enabled=c.CanDuplex;if(!duplex.Enabled)duplex.Checked=false;
        capabilities.Text=$"Availability: {selected.Printer.Status}\r\nColor: {(c.SupportsColor?"driver reports supported":"driver does not report support")} · Duplex: {(c.CanDuplex?"driver reports supported":"driver does not report support")}\r\nPaper sizes: {string.Join(", ",c.PaperSizes)}\r\nResolutions: {string.Join(", ",c.Resolutions)}\r\nSource: {c.Source}";
    }

    private async Task ConnectOwnerAsync() {
        connect.Enabled=false;status.Text="Connecting securely…";
        try {
            if(createAccount.Checked)NormalizeShopSlug();
            var baseUrl=apiUrl.Text.Trim();
            if(!Uri.TryCreate(baseUrl,UriKind.Absolute,out var uri)||!SafeUrl(uri))throw new InvalidOperationException("Enter a public HTTPS API address, including /api (HTTP is allowed only for localhost development).");
            ownerApi?.Dispose();ownerApi=new AgentApiClient(baseUrl);
            string? createdShopId=null;string? createdShopSlug=null;string? createdShopName=null;
            if(createAccount.Checked) {
                using var registration=await ownerApi.PostAsync("auth/register/shop-owner",new{
                    ownerName=ownerName.Text.Trim(),email=email.Text.Trim(),password=password.Text,
                    shopName=shopName.Text.Trim(),slug=shopSlug.Text.Trim(),
                });
                var token=registration.RootElement.GetProperty("token").GetString();
                var shop=registration.RootElement.GetProperty("shop");
                createdShopId=shop.GetProperty("id").GetString();
                createdShopSlug=shop.GetProperty("slug").GetString();
                createdShopName=shop.GetProperty("name").GetString();
                password.Clear();
                if(string.IsNullOrWhiteSpace(token)||string.IsNullOrWhiteSpace(createdShopId)||string.IsNullOrWhiteSpace(createdShopSlug))throw new InvalidOperationException("Registration did not return a complete owner session and shop.");
                ownerApi.Dispose();ownerApi=new AgentApiClient(baseUrl,token);
            } else {
                using var login=await ownerApi.PostAsync("auth/login",new{email=email.Text.Trim(),password=password.Text});
                if(login.RootElement.GetProperty("role").GetString()!="SHOP_OWNER")throw new InvalidOperationException("This account is not a shop owner. Choose a shop-owner account.");
                var token=login.RootElement.GetProperty("token").GetString();
                password.Clear();
                if(string.IsNullOrWhiteSpace(token))throw new InvalidOperationException("Owner sign-in did not return a session token.");
                ownerApi.Dispose();ownerApi=new AgentApiClient(baseUrl,token);
            }
            using var health=await ownerApi.GetAsync("health");
            mode=(health.RootElement.GetProperty("executionMode").GetString()??"").ToUpperInvariant();
            if(mode is not("REAL" or "SIMULATED"))throw new InvalidOperationException("The API did not return a supported print mode.");
            shops.Items.Clear();
            if(createdShopId is not null&&createdShopSlug is not null) {
                shops.Items.Add(new ShopOption(createdShopId,createdShopSlug,createdShopName??"Shop",$"{createdShopName} (/{createdShopSlug})"));
                shops.SelectedIndex=0;
            } else {
                using var shopsResponse=await ownerApi.GetAsync("owner/shops");
                shops.Items.Add(new ShopOption(null,null,"","Create a new shop"));
                foreach(var item in shopsResponse.RootElement.EnumerateArray()) {
                    var slug=item.GetProperty("slug").GetString()??"";
                    var name=item.GetProperty("name").GetString()??"Shop";
                    shops.Items.Add(new ShopOption(item.GetProperty("id").GetString(),slug,name,$"{name} (/{slug})"));
                }
                shops.SelectedIndex=0;
            }
            signedIn=true;createAccount.Enabled=false;existingAccount.Enabled=false;ownerName.Enabled=false;email.Enabled=false;password.Enabled=false;
            rescan.Enabled=true;await DiscoverQueuesAsync();
            status.Text=queues.Items.Count==0
                ? $"No installed printer queue was found. You can finish the shop and QR setup now, then rerun this wizard after installing a printer. Server print mode: {mode}."
                : createdShopId is null
                    ? $"Signed in as shop owner. Server print mode: {mode}. Select a shop or create one."
                    : $"Shop-owner account and shop created. Server print mode: {mode}.";
        } catch(Exception ex) {
            status.Text=ex.Message;
        } finally {
            connect.Enabled=!signedIn;UpdateAccountFields();UpdateSetupEnabled();
        }
    }

    private async Task DiscoverQueuesAsync() {
        try {
            rescan.Enabled=false;queues.Items.Clear();
            var discovered=(await new WindowsQueueAdapter().DiscoverAsync()).Where(p=>p.InstalledQueue).OrderBy(p=>p.Name,StringComparer.OrdinalIgnoreCase).ToArray();
            foreach(var printer in discovered)queues.Items.Add(new QueueOption(printer,$"{printer.Name} — {printer.Status}"));
            if(queues.Items.Count>0)queues.SelectedIndex=0;
            ShowCapabilities();
            if(discovered.Length==0)status.Text="No installed Windows printer queue was found. Continue to create the shop and QR; install a printer and run setup again to enroll the print agent.";
        } catch(Exception ex) {
            status.Text=$"Printer discovery failed. You can still finish shop and QR setup without enrolling an agent. Details: {ex.Message}";
        } finally {
            rescan.Enabled=signedIn;UpdateSetupEnabled();
        }
    }

    private void UpdateSetupEnabled() {
        var shopReady=shops.SelectedItem is ShopOption selected&&(selected.Id is not null||(shopName.Text.Trim().Length>=2&&Regex.IsMatch(shopSlug.Text.Trim(),"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")));
        setup.Enabled=signedIn&&ownerApi is not null&&shopReady;
    }

    private async Task CompleteSetupAsync() {
        setup.Enabled=false;downloadQr.Visible=false;success.Visible=false;qrPreview.Visible=false;
        try {
            if(ownerApi is null||shops.SelectedItem is not ShopOption shopOption)throw new InvalidOperationException("Sign in before continuing.");
            string shopId;string shopSlugValue;string shopLabel;
            if(shopOption.Id is null) {
                using var created=await ownerApi.PostAsync("shops",new{name=shopName.Text.Trim(),slug=shopSlug.Text.Trim()});
                shopId=created.RootElement.GetProperty("id").GetString()??throw new InvalidOperationException("Shop creation returned no ID.");
                shopSlugValue=created.RootElement.GetProperty("slug").GetString()??shopSlug.Text.Trim();
                shopLabel=created.RootElement.GetProperty("name").GetString()??shopName.Text.Trim();
                var savedShop=new ShopOption(shopId,shopSlugValue,shopLabel,$"{shopLabel} (/{shopSlugValue})");
                shops.Items.Add(savedShop);shops.SelectedItem=savedShop;
            } else {
                shopId=shopOption.Id;shopSlugValue=shopOption.Slug??throw new InvalidOperationException("Selected shop has no URL slug.");shopLabel=shopOption.Name;
            }

            var enrolledAgent=false;
            if(queues.SelectedItem is QueueOption queue) {
                var printer=queue.Printer;var cap=printer.Capabilities;
                using var registeredPrinters=await ownerApi.GetAsync($"shops/{Uri.EscapeDataString(shopId)}/printers");
                var existingPrinter=registeredPrinters.RootElement.EnumerateArray().FirstOrDefault(p=>string.Equals(p.GetProperty("queueName").GetString(),printer.Name,StringComparison.OrdinalIgnoreCase));
                string printerId;
                if(existingPrinter.ValueKind==System.Text.Json.JsonValueKind.Object)printerId=existingPrinter.GetProperty("id").GetString()??throw new InvalidOperationException("Existing printer record returned no ID.");
                else {
                    using var printerResponse=await ownerApi.PostAsync($"shops/{Uri.EscapeDataString(shopId)}/printers",new{
                        name=printer.Name,queueName=printer.Name,connectionType="WINDOWS_QUEUE",
                        status=printer.Available?$"AVAILABLE:{printer.Status}":$"UNAVAILABLE:{printer.Status}",
                        capabilities=cap is null?null:new{source=cap.Source,supportsColor=cap.SupportsColor,canDuplex=cap.CanDuplex,paperSizes=cap.PaperSizes,resolutions=cap.Resolutions},
                    });
                    printerId=printerResponse.RootElement.GetProperty("id").GetString()??throw new InvalidOperationException("Printer registration returned no ID.");
                }
                using var savedOptions=await ownerApi.PutAsync($"shops/{Uri.EscapeDataString(shopId)}/settings",new{supportsDuplex=duplex.Checked});
                using var agent=await ownerApi.PostAsync($"shops/{Uri.EscapeDataString(shopId)}/agents",new{name=Environment.MachineName,printerId,mode});
                var credential=agent.RootElement.GetProperty("credential").GetString()??throw new InvalidOperationException("Device enrollment returned no credential.");
                await AgentLocalSettings.SaveAsync(new AgentSettings(apiUrl.Text.Trim(),mode),credential);
                SetStartupEntry(startOnLogin.Checked);enrolledAgent=true;
            }

            var qrBytes=await ownerApi.GetBytesAsync($"shops/{Uri.EscapeDataString(shopSlugValue)}/qr.png");
            ShowQrPreview(qrBytes);completedShopSlug=shopSlugValue;downloadQr.Visible=true;success.Visible=true;
            success.Text=$"Setup complete for {shopLabel}. Your public shop QR is ready.";
            status.Text=enrolledAgent
                ? "The Windows Agent is enrolled and its credential is protected for this Windows user with DPAPI. No print job was sent."
                : "No printer queue was registered and no Agent credential was created. Install a printer, rerun this wizard, and select this shop to enroll the Agent.";
            if(enrolledAgent&&MessageBox.Show(this,"Shop setup is complete. Start the QR Print agent now?","QR Print setup",MessageBoxButtons.YesNo,MessageBoxIcon.Information)==DialogResult.Yes)StartAgent();
        } catch(Exception ex) {
            status.Text=$"Setup could not finish: {ex.Message}";
        } finally {
            UpdateSetupEnabled();
        }
    }

    private void ShowQrPreview(byte[] bytes) {
        using var stream=new MemoryStream(bytes);
        using var image=Image.FromStream(stream);
        qrPreview.Image?.Dispose();qrPreview.Image=new Bitmap(image);qrPreview.Visible=true;
    }

    private void DownloadQr() {
        if(qrPreview.Image is null||string.IsNullOrWhiteSpace(completedShopSlug))return;
        using var dialog=new SaveFileDialog{Title="Download your shop QR code",Filter="PNG image (*.png)|*.png",FileName=$"{completedShopSlug}-shop-qr.png",AddExtension=true,DefaultExt="png"};
        if(dialog.ShowDialog(this)!=DialogResult.OK)return;
        try { qrPreview.Image.Save(dialog.FileName,System.Drawing.Imaging.ImageFormat.Png);status.Text=$"QR code saved to {dialog.FileName}."; }
        catch(Exception ex) { status.Text=$"Could not save the QR image: {ex.Message}"; }
    }

    private void NormalizeShopSlug() {
        var normalized=Regex.Replace(shopSlug.Text.Trim().ToLowerInvariant(),"[^a-z0-9]+","-").Trim('-');
        if(shopSlug.Text==normalized)return;
        shopSlug.Text=normalized;
        shopSlug.SelectionStart=shopSlug.TextLength;
    }

    private bool HasStartupEntry() {
        try { using var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",false);return !string.IsNullOrWhiteSpace(key?.GetValue(StartupValue) as string); }
        catch { return false; }
    }

    private static void SetStartupEntry(bool enabled) {
        var executable=Environment.ProcessPath;if(string.IsNullOrWhiteSpace(executable))return;
        using var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",true);
        if(enabled)key?.SetValue(StartupValue,$"\"{executable}\"");else key?.DeleteValue(StartupValue,false);
    }

    private void StartAgent() {
        var executable=Environment.ProcessPath;if(!string.IsNullOrWhiteSpace(executable))Process.Start(new ProcessStartInfo(executable){UseShellExecute=true});
    }

    private static bool SafeUrl(Uri uri) {
        var local=uri.IsLoopback||uri.Host.Equals("localhost",StringComparison.OrdinalIgnoreCase);
        return (uri.Scheme==Uri.UriSchemeHttps||local&&uri.Scheme==Uri.UriSchemeHttp)
            &&string.IsNullOrEmpty(uri.UserInfo)&&string.IsNullOrEmpty(uri.Query)&&string.IsNullOrEmpty(uri.Fragment);
    }

    protected override void Dispose(bool disposing) {
        if(disposing){ownerApi?.Dispose();qrPreview.Image?.Dispose();}
        base.Dispose(disposing);
    }

    private sealed record ShopOption(string? Id,string? Slug,string Name,string Label) { public override string ToString()=>Label; }
    private sealed record QueueOption(PrinterInfo Printer,string Label) { public override string ToString()=>Label; }
}
