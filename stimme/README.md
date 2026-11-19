# stimme (nur Windows)

Liest die Antworten von Claude lokal vor und hilft beim Diktieren. Gebaut als Ersatz für Remote Control, wenn ein
Firmen-Proxy `/rc` blockt. Kein Text verlässt den Rechner.

## Was es kann

- **Vorlesen**: nach jeder fertigen Antwort alles seit dem letzten Prompt, ohne Code, Tabellen, Links, Pfade und Emojis
  (höchstens 6000 Zeichen). Ein neuer Prompt stoppt die Stimme. An/aus gilt pro Session, sonst reden parallele
  Sessions durcheinander.
- **Knopfzeile oben im `/verbrauch`-Pane**: Vorlesen an/aus, Pause/Weiter, Stopp, Nochmal (letzte Antwort neu),
  Diktieren, Diktat: DE/EN (Sprache wechseln), Tempo −/+ (1.0 = natürlich), Stimme (reihum), Ausgabe (automatisch
  oder ein bestimmtes Gerät). Braucht verbrauch ab 0.7.4 (das Pane gibt dort oben Platz für andere Mods).
- **Befehle**: `/vorlesen an | aus | stopp | pause | nochmal | stimme [name] | ausgabe | test`,
  `/diktat | de | en | wechseln`.
- **Diktieren**: Win+H kennt Deutsch (Schweiz) nicht. `/diktat` und der Knopf stellen alle Terminal-Fenster auf
  Deutsch (Deutschland) oder Englisch (USA), beide mit Schweizer Tastatur; fehlt die Sprache in der Windows-Sprachliste,
  wird sie ergänzt (nur Benutzer, kein Admin). Der Knopf „Diktieren“ drückt danach Esc (Fokus zurück in die Eingabe)
  und Win+H. Die gewählte Sprache gilt für alle Sessions und bleibt über einen Neustart.
- **Ausgabegerät automatisch**: Bluetooth-Kopfhörer (Stereo vor Freisprech) > USB-Headset > Realtek > Windows-Standard.
  Der Windows-Standard selbst bleibt unverändert.

## Voraussetzungen

1. **Piper** (piper-tts 1.8) in einer eigenen Python-Umgebung, ohne Admin-Rechte:

   ```powershell
   py -3.12 -m venv $env:USERPROFILE\.local\piper-venv
   & $env:USERPROFILE\.local\piper-venv\Scripts\python.exe -m pip install piper-tts==1.8.0
   ```

   Die Windows-exe von Piper (Release 2023.11.14-2) liest mit piper-tts 1.8 trainierte Stimmen **nicht**
   („"aɪ" is not a single codepoint").

2. **Stimmen** nach `%USERPROFILE%\.local\piper\voices\`, je `de_DE-<name>-medium.onnx` + `.onnx.json`.
   Der Knopf kennt `danneberg`, `robert`, `terrenceclean`, `terrence` und `karsten` (Windows-Stimme, Notweg).
   Fehlen Python oder Stimme, spricht automatisch Karsten.

3. In `CLAUDE_CODE_PLUGIN_DIRS` eintragen, wie die anderen Mods.

## Wie es läuft

- `scripts/sprechen.ps1` bekommt den Text per stdin, startet `scripts/piper_teile.py` (lädt das Modell einmal und
  erzeugt Abschnitt für Abschnitt voraus) und spielt über MCI (winmm) ab, damit Pause/Weiter und die Wahl des
  Ausgabegeräts gehen. Erster Ton nach etwa 2 Sekunden.
- Steuerung über Dateien im Datenordner des Mods (`steuerung.txt`, `tempo.txt`, `stimme.txt`, `geraet.txt`),
  Protokoll in `stimme.log`. Auf dem ganzen Rechner spricht immer nur eine Stimme.
- Fallen: MCI scheitert an langen Pfaden (Fehler 304), die WAVs liegen deshalb kurz in `%TEMP%`. Ein `ui.render`-Hook
  auf das Fenster eines anderen Mods braucht `plugin` im Matcher, sonst hört er nur auf eigene Fenster.

Auf dem Mac registriert der Mod nichts und zeichnet nichts.
