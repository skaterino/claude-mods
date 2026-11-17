# Stellt alle offenen Terminal-Fenster auf Deutsch (Deutschland) mit Schweizer Tastatur,
# damit die Windows-Spracheingabe (Win+H) funktioniert. de-CH kennt Win+H nicht.
# -WinH: danach Esc (Fokus vom Knopf zurück in die Eingabe) und Win+H drücken, also gleich zuhören.
param([switch]$WinH)

# de-DE mit Schweizer Layout in der Sprachliste sicherstellen (nur Benutzer, kein Admin)
$list = Get-WinUserLanguageList
$de = $list | Where-Object { $_.LanguageTag -eq 'de-DE' }
if (-not $de) {
  $list.Add('de-DE')
  $de = $list | Where-Object { $_.LanguageTag -eq 'de-DE' }
  $de.InputMethodTips.Clear(); $de.InputMethodTips.Add('0407:00000807')
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
[void][StimmeKb]::LoadKeyboardLayout('00000407', 0)
$ziele = @()
foreach ($h in [StimmeKb]::Visible()) {
  $procId = 0; [void][StimmeKb]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -in 'WindowsTerminal', 'conhost', 'OpenConsole' -and $p.MainWindowHandle -ne 0) { $ziele += $h }
}
foreach ($h in $ziele) { [void][StimmeKb]::PostMessage($h, 0x0050, [IntPtr]::Zero, [IntPtr]0x08070407) }
Start-Sleep -Milliseconds 400
$ok = 0
foreach ($h in $ziele) {
  $procId = 0; $tid = [StimmeKb]::GetWindowThreadProcessId($h, [ref]$procId)
  if (([StimmeKb]::GetKeyboardLayout($tid).ToInt64() -band 0xFFFF) -eq 0x0407) { $ok++ }
}
if ($WinH) {
  [StimmeKb]::Taste(0x1B)          # Esc: Fokus vom Knopf im Fenster zurück in die Eingabezeile
  Start-Sleep -Milliseconds 200
  [StimmeKb]::WinH()
}
"$ok/$($ziele.Count)"
