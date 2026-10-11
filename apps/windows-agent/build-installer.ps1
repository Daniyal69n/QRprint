$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$project = Join-Path $PSScriptRoot 'QRPrint.Agent.csproj'
$script = Join-Path $PSScriptRoot 'installer\QRPrint.iss'
$publishDir = Join-Path $PSScriptRoot 'publish\win-x64'

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) { throw 'Install the .NET 8 SDK for Windows x64 before building the installer.' }
$sdks = & $dotnet.Source --list-sdks
if ($LASTEXITCODE -ne 0 -or -not ($sdks | Where-Object { $_ -match '^8\.' })) {
    throw 'The .NET 8 SDK is missing. Install the Windows x64 .NET 8 SDK, reopen PowerShell, then rerun this script.'
}

$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
    $candidates = @('C:\Program Files (x86)\Inno Setup 6\ISCC.exe','C:\Program Files\Inno Setup 6\ISCC.exe')
    $isccPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $isccPath) { throw 'Inno Setup 6 is missing. Install it, reopen PowerShell, then rerun this script.' }
} else { $isccPath = $iscc.Source }

Push-Location $projectRoot
try {
    & $dotnet.Source publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:Version=0.1.0 -o $publishDir
    if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed; installer was not created.' }
    & $isccPath $script
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed; installer was not created.' }
    $installer = Join-Path $projectRoot 'dist\installer\QRPrint-Shop-Setup-x64.exe'
    if (-not (Test-Path -LiteralPath $installer)) { throw 'Inno Setup returned success but the expected installer file is missing.' }
    Write-Output "Installer created: $installer"
    Write-Output 'This generic installer contains no shop account, API token, or printer-specific secret. Each shop enrolls after installation.'
} finally { Pop-Location }
