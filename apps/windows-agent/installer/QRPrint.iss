#define ProductName "QR Print Shop Agent"
#define ProductVersion "0.1.0"
#define PublishDir "..\publish\win-x64"

[Setup]
AppId={{ED26D4BB-6EAA-4FCB-9748-5D6B1C73473B}
AppName={#ProductName}
AppVersion={#ProductVersion}
AppPublisher=QR Print
DefaultDirName={autopf}\QR Print Shop Agent
DefaultGroupName=QR Print
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
OutputDir=..\..\..\dist\installer
OutputBaseFilename=QRPrint-Shop-Setup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#ProductName}

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#PublishDir}\QRPrint.Agent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\QR Print Agent"; Filename: "{app}\QRPrint.Agent.exe"
Name: "{group}\Set up this shop"; Filename: "{app}\QRPrint.Agent.exe"; Parameters: "--onboard"
Name: "{group}\Discover installed printers"; Filename: "{app}\QRPrint.Agent.exe"; Parameters: "--discover"
Name: "{autodesktop}\QR Print Agent"; Filename: "{app}\QRPrint.Agent.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\QRPrint.Agent.exe"; Parameters: "--onboard"; Description: "Set up this shop's printer and QR"; Flags: postinstall nowait skipifsilent runasoriginaluser
