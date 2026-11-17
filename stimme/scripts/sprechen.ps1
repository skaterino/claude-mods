# Liest UTF-8-Text von stdin und spricht ihn lokal: Piper-Stimme (Standard Danneberg) oder Windows-Stimme Karsten.
# Steuerung über Dateien im Datenordner (-Daten):
#   steuerung.txt  "pause" = anhalten, "stopp" = beenden, sonst weiterlaufen
#   tempo.txt      Sprechtempo (1.0 = natürlich), wird pro Abschnitt gelesen
#   stimme.txt     Piper-Stimme (danneberg, robert, terrence, terrenceclean) oder "karsten"
#   geraet.txt     optional: Teil des Namens des Ausgabegeräts, das Vorrang hat
# Nur eine Stimme gleichzeitig auf dem Rechner: ein neuer Aufruf beendet den vorherigen.
param([Parameter(Mandatory = $true)][string]$Daten)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$text = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($text)) { exit 0 }

New-Item -ItemType Directory -Force $Daten | Out-Null
$pidDatei = Join-Path $Daten 'stimme.pid'
$steuerDatei = Join-Path $Daten 'steuerung.txt'
$tempoDatei = Join-Path $Daten 'tempo.txt'
$logDatei = Join-Path $Daten 'stimme.log'
function Log([string]$z) { try { [IO.File]::AppendAllText($logDatei, "$(Get-Date -Format 'HH:mm:ss.fff') [$PID] $z`r`n") } catch { } }
if ((Test-Path $logDatei) -and (Get-Item $logDatei).Length -gt 200KB) { Remove-Item $logDatei -ErrorAction SilentlyContinue }
Log "start, $($text.Length) Zeichen"

if (Test-Path $pidDatei) {
  $alt = (Get-Content $pidDatei -ErrorAction SilentlyContinue) -as [int]
  if ($alt -and $alt -ne $PID) {
    $p = Get-Process -Id $alt -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'powershell') { Stop-Process -Id $alt -Force -ErrorAction SilentlyContinue }
  }
}
[IO.File]::WriteAllText($pidDatei, "$PID")
# Reste abgebrochener Vorlesungen (älter als 10 Minuten) wegräumen
Get-ChildItem $env:TEMP -Filter 'cst*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-10) } | Remove-Item -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($steuerDatei, '')

function Lies-Steuerung {
  try { return ([IO.File]::ReadAllText($steuerDatei)).Trim() } catch { return '' }
}
function Lies-Tempo {
  try {
    $t = [double]::Parse(([IO.File]::ReadAllText($tempoDatei)).Trim(), [Globalization.CultureInfo]::InvariantCulture)
    if ($t -ge 0.5 -and $t -le 4) { return $t }
  } catch { }
  return 1.0
}

Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class StimmeMci {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
  public static extern int mciSendString(string cmd, StringBuilder ret, int len, IntPtr cb);
  [DllImport("winmm.dll")] public static extern int waveOutGetNumDevs();
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int waveOutGetDevCaps(UIntPtr id, ref WaveOutCaps caps, int size);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct WaveOutCaps { public ushort mid; public ushort pid; public uint ver; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string name; public uint formats; public ushort channels; public ushort reserved; public uint support; }
  public static int Finde(string teil) {
    int n = waveOutGetNumDevs();
    for (int i = 0; i < n; i++) { var c = new WaveOutCaps(); waveOutGetDevCaps((UIntPtr)i, ref c, Marshal.SizeOf(c)); if (c.name != null && c.name.IndexOf(teil, StringComparison.OrdinalIgnoreCase) >= 0) return i; }
    return -1;
  }
  public static string Senden(string cmd) { var sb = new StringBuilder(128); mciSendString(cmd, sb, 128, IntPtr.Zero); return sb.ToString(); }
}
'@

# Stimme: stimme.txt (Standard danneberg). "karsten" = Windows-Stimme. Fehlt Piper oder das Modell: Karsten.
$stimmeDatei = Join-Path $Daten 'stimme.txt'
$stimmeName = 'danneberg'
if (Test-Path $stimmeDatei) { $sn = ([IO.File]::ReadAllText($stimmeDatei)).Trim(); if ($sn) { $stimmeName = $sn } }
$piperPython = Join-Path $env:USERPROFILE '.local\piper-venv\Scripts\python.exe'
$piperModell = Join-Path $env:USERPROFILE ".local\piper\voices\de_DE-$stimmeName-medium.onnx"
$mitPiper = ($stimmeName -ne 'karsten') -and (Test-Path $piperPython) -and (Test-Path $piperModell)
Log "stimme '$stimmeName', piper=$mitPiper"

if (-not $mitPiper) {
  [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  $s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  $voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  $voice = $voices | Where-Object { $_.Language -eq 'de-CH' } | Select-Object -First 1
  if (-not $voice) { $voice = $voices | Where-Object { $_.Language -like 'de-*' } | Select-Object -First 1 }
  if ($voice) { $s.Voice = $voice }
}

# Karsten ist von Natur aus langsam: Tempo 1.0 im Fenster = Karsten-Rate 1.4
function Erzeuge-Wav([string]$teil, [string]$ziel) {
  try { $s.Options.SpeakingRate = [Math]::Min(6, (Lies-Tempo) * 1.4) } catch { }
  $op = $s.SynthesizeTextToStreamAsync($teil)
  $t = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op)); $t.Wait()
  $stream = $t.Result; $size = [int]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $lt = $asTask.MakeGenericMethod([uint32]).Invoke($null, @($reader.LoadAsync($size))); $lt.Wait()
  $bytes = New-Object byte[] $size; $reader.ReadBytes($bytes)
  [IO.File]::WriteAllBytes($ziel, $bytes)
}

# In Abschnitte von etwa 350 Zeichen teilen (an Zeilen), damit es schnell anfängt
$teile = New-Object System.Collections.Generic.List[string]
$puffer = ''
foreach ($zeile in ($text -split "`r?`n")) {
  if ($zeile.Trim() -eq '') { continue }
  if ($puffer.Length -gt 0 -and ($puffer.Length + $zeile.Length) -gt 350) { $teile.Add($puffer); $puffer = '' }
  $puffer = if ($puffer) { "$puffer`n$zeile" } else { $zeile }
}
if ($puffer) { $teile.Add($puffer) }

# Piper früh starten: lädt das Modell, während unten das Ausgabegerät gesucht wird
$praefix = "cst$PID"
$py = $null
if ($mitPiper) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo $piperPython
  $psi.Arguments = "`"$PSScriptRoot\piper_teile.py`" --modell `"$piperModell`" --ordner `"$env:TEMP`" --praefix $praefix --steuerung `"$steuerDatei`" --tempo `"$tempoDatei`" --eltern $PID"
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardInput = $true
  $psi.EnvironmentVariables['PYTHONUTF8'] = '1'
  $py = [Diagnostics.Process]::Start($psi)
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($teile -join [string][char]0x1E))
  $py.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length); $py.StandardInput.Close()
}

# Ausgabegerät, Vorrang: geraet.txt > Bluetooth-Kopfhörer (Stereo vor Freisprech) > USB-Headset > Realtek > Windows-Standard
$geraetDatei = Join-Path $Daten 'geraet.txt'
$wunschName = ''
if (Test-Path $geraetDatei) { $wunschName = ([IO.File]::ReadAllText($geraetDatei)).Trim() }
# Aus der Registry (schnell, ~0.3 s; Get-PnpDevice braucht ~6 s). DeviceState 1 = aktiv.
# Bus aus dem Gerätepfad: BTHENUM = Bluetooth-Stereo, BTHHFENUM = Bluetooth-Freisprech, USB, HDAUDIO = eingebaut
$ausgaben = @()
foreach ($k in (Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render' -ErrorAction SilentlyContinue)) {
  if ((Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).DeviceState -ne 1) { continue }
  $p = Get-ItemProperty "$($k.PSPath)\Properties" -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $name = "$($p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2') ($($p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'))"
  $bus = if ("$($p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},2')" -match '^\{\d+\}\.([A-Z]+)\\') { $Matches[1] } else { '' }
  $ausgaben += "$bus|$name"
}
Log "ausgaben: $($ausgaben -join '; ')"
$kandidaten = @()
if ($wunschName) { $kandidaten += $wunschName }
foreach ($a in $ausgaben) { if ($a -like 'BTHENUM|*') { $kandidaten += $a.Split('|', 2)[1] } }
foreach ($a in $ausgaben) { if ($a -like 'BTHHFENUM|*') { $kandidaten += $a.Split('|', 2)[1] } }
foreach ($a in $ausgaben) { if ($a -match '^USB\|(Headset|Headphones|Kopfh|Speaker \(Jabra)' -and $a -notmatch 'Dock') { $kandidaten += $a.Split('|', 2)[1] } }
$kandidaten += 'Realtek'
$geraet = -1; $geraetName = ''
foreach ($k in $kandidaten) {
  if (-not $k) { continue }
  $teil = if ($k.Length -gt 31) { $k.Substring(0, 31) } else { $k }
  $i = [StimmeMci]::Finde($teil)
  if ($i -ge 0) { $geraet = $i; $geraetName = $k; break }
}
Log "geraet '$geraetName' = $geraet"
$alias = "stimme$PID"

# Spielt eine WAV-Datei (kurzer Pfad, MCI scheitert an langen Pfaden mit Fehler 304) mit Pause/Stopp ab.
# Gibt $true zurück, wenn gestoppt wurde.
function Spiele([string]$wav) {
  $rc = [StimmeMci]::mciSendString("open `"$wav`" type waveaudio alias $alias", $null, 0, [IntPtr]::Zero)
  Log "spiele $((Get-Item $wav).Length) Bytes, mci open rc=$rc"
  if ($rc -ne 0) {
    (New-Object System.Media.SoundPlayer $wav).PlaySync()   # Notweg ohne Pause, Windows-Standardgerät
    return ((Lies-Steuerung) -eq 'stopp')
  }
  if ($geraet -ge 0) { $rcg = [StimmeMci]::mciSendString("set $alias output $geraet", $null, 0, [IntPtr]::Zero); if ($rcg -ne 0) { Log "set output rc=$rcg" } }
  [void][StimmeMci]::Senden("play $alias")
  $pausiert = $false; $wunsch = ''
  while ($true) {
    Start-Sleep -Milliseconds 120
    $wunsch = Lies-Steuerung
    if ($wunsch -eq 'stopp') { break }
    if ($wunsch -eq 'pause' -and -not $pausiert) { [void][StimmeMci]::Senden("pause $alias"); $pausiert = $true }
    elseif ($wunsch -ne 'pause' -and $pausiert) { [void][StimmeMci]::Senden("resume $alias"); $pausiert = $false }
    if (-not $pausiert -and [StimmeMci]::Senden("status $alias mode") -ne 'playing') { break }
  }
  [void][StimmeMci]::Senden("close $alias")
  return ($wunsch -eq 'stopp')
}

try {
  for ($n = 0; $n -lt $teile.Count; $n++) {
    if ((Lies-Steuerung) -eq 'stopp') { break }
    $wav = Join-Path $env:TEMP "$praefix-$n.wav"
    if ($mitPiper) {
      # warten, bis Piper den Abschnitt fertig hat
      while (-not (Test-Path $wav)) {
        if ((Lies-Steuerung) -eq 'stopp') { break }
        if ($py.HasExited -and -not (Test-Path $wav)) { Log "piper beendet (Exit $($py.ExitCode)) ohne Abschnitt $n"; break }
        Start-Sleep -Milliseconds 50
      }
      if (-not (Test-Path $wav)) { break }
    } else {
      Erzeuge-Wav $teile[$n] $wav
    }
    $gestoppt = Spiele $wav
    Remove-Item $wav -ErrorAction SilentlyContinue
    if ($gestoppt) { break }
  }
} catch {
  Log "FEHLER: $($_.Exception.Message)"
  throw
} finally {
  Log "ende"
  [void][StimmeMci]::Senden("close $alias")
  if ($py -and -not $py.HasExited) { try { $py.Kill() } catch { } }
  Get-ChildItem $env:TEMP -Filter "$praefix*" -ErrorAction SilentlyContinue | Remove-Item -ErrorAction SilentlyContinue
  if ((Get-Content $pidDatei -ErrorAction SilentlyContinue) -eq "$PID") { Remove-Item $pidDatei -ErrorAction SilentlyContinue }
}
