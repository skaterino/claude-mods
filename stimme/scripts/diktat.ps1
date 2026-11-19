# Stellt alle offenen Terminal-Fenster auf die Diktat-Sprache, mit Schweizer Tastatur,
# damit die Windows-Spracheingabe (Win+H) funktioniert. de-CH kennt Win+H nicht.
# -Sprache de: Deutsch (Deutschland), en: Englisch (USA). Die Tastatur bleibt in beiden Fällen Schweizerdeutsch.
# -WinH: danach Esc (Fokus vom Knopf zurück in die Eingabe) und Win+H drücken, also gleich zuhören.
param([ValidateSet('de', 'en')][string]$Sprache = 'de', [switch]$WinH)

$tag  = @{ de = 'de-DE'; en = 'en-US' }[$Sprache]
$lang = @{ de = 0x0407;  en = 0x0409  }[$Sprache]
$tip  = '{0:X4}:00000807' -f $lang
$hkl  = [IntPtr](0x08070000 -bor $lang)

# Sprache mit Schweizer Layout in der Sprachliste sicherstellen (nur Benutzer, kein Admin)
$list = Get-WinUserLanguageList
$eintrag = $list | Where-Object { $_.LanguageTag -eq $tag }
if (-not $eintrag) {
  $list.Add($tag)
  $eintrag = $list | Where-Object { $_.LanguageTag -eq $tag }
  $eintrag.InputMethodTips.Clear(); $eintrag.InputMethodTips.Add($tip)
  Set-WinUserLanguageList $list -Force -WarningAction SilentlyContinue
}

Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Threading;
public static class StimmeKb {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint tid);
  [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static List<IntPtr> Visible() { var r = new List<IntPtr>(); EnumWindows((h,l)=>{ if (IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero); return r; }
  const uint UP = 2;
  public static void Taste(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, UP, UIntPtr.Zero); }
  public static void WinH() {
    keybd_event(0x5B, 0, 0, UIntPtr.Zero); Thread.Sleep(30);
    keybd_event(0x48, 0, 0, UIntPtr.Zero); keybd_event(0x48, 0, UP, UIntPtr.Zero); Thread.Sleep(30);
    keybd_event(0x5B, 0, UP, UIntPtr.Zero);
  }
}
'@
[void][StimmeKb]::LoadKeyboardLayout(('{0:X8}' -f $lang), 0)
$ziele = @()
foreach ($h in [StimmeKb]::Visible()) {
  $procId = 0; [void][StimmeKb]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -in 'WindowsTerminal', 'conhost', 'OpenConsole' -and $p.MainWindowHandle -ne 0) { $ziele += $h }
}
function Test-Umgestellt($h) {
  $procId = 0; $tid = [StimmeKb]::GetWindowThreadProcessId($h, [ref]$procId)
  ([StimmeKb]::GetKeyboardLayout($tid).ToInt64() -band 0xFFFF) -eq $lang
}
foreach ($h in $ziele) { [void][StimmeKb]::PostMessage($h, 0x0050, [IntPtr]::Zero, $hkl) }
# Das Terminal verarbeitet die Nachricht manchmal erst nach über einer Sekunde: bis 2.5 s nachprüfen, nach 1 s nochmal schicken
$ok = 0
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 250
  $offen = @($ziele | Where-Object { -not (Test-Umgestellt $_) })
  $ok = $ziele.Count - $offen.Count
  if ($offen.Count -eq 0) { break }
  if ($i -eq 3) { foreach ($h in $offen) { [void][StimmeKb]::PostMessage($h, 0x0050, [IntPtr]::Zero, $hkl) } }
}
if ($WinH) {
  [StimmeKb]::Taste(0x1B)          # Esc: Fokus vom Knopf im Fenster zurück in die Eingabezeile
  Start-Sleep -Milliseconds 200
  [StimmeKb]::WinH()
}
"$ok/$($ziele.Count)"
