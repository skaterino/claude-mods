# Listet die aktiven Ausgabegeräte (Wiedergabe), je Zeile "BUS|Name", z. B. "BTHENUM|Headphones (Jabra Evolve2 55)".
# BUS: BTHENUM = Bluetooth-Stereo, BTHHFENUM = Bluetooth-Freisprech, USB, HDAUDIO = eingebaut / Bildschirm.
# Aus der Registry (schnell); DeviceState 1 = aktiv. Ausgabe UTF-8.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
foreach ($k in (Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render' -ErrorAction SilentlyContinue)) {
  if ((Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).DeviceState -ne 1) { continue }
  $p = Get-ItemProperty "$($k.PSPath)\Properties" -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $name = "$($p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2') ($($p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'))"
  $bus = if ("$($p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},2')" -match '^\{\d+\}\.([A-Z]+)\\') { $Matches[1] } else { '' }
  [Console]::Out.WriteLine("$bus|$name")
}
