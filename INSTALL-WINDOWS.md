# Installation auf Windows

Diese Anleitung ist für Claude Code auf Mikes Windows-Rechner. Sie installiert die Mods `verbrauch` und `sessions` aus
diesem Repo und auf Wunsch `clean-view`. Die Schritte nacheinander abarbeiten und jeden Prüfpunkt wirklich prüfen, nicht
annehmen.

Stand des Repos: verbrauch 0.7.2, sessions 0.4.1. Entwickelt und getestet auf dem Mac (Claude Code 2.1.296). Auf Windows
ist es noch nicht getestet. Was dort anders ist, steht unter „Bekannte Unterschiede“.

## Was vorher klar sein muss

1. **Ort ist fest:** Das Repo muss genau unter `%USERPROFILE%\.claude\mods` liegen. `sessions` ruft seine Hilfsdatei
   über den festen Pfad `~/.claude/mods/sessions/liste.js` auf. Ein anderer Ort bricht `/sessions`.
2. **Das Repo ist öffentlich:** Zum Klonen braucht es keine Anmeldung. Zum Pushen braucht es eine GitHub-Anmeldung als
   `skaterino`, zum Beispiel mit `gh auth login`. Fehlt sie, Mike bitten, sie selbst zu machen (`! gh auth login`).
   Niemals ein Token in einen Befehl oder eine Datei schreiben.
3. **Claude Code aktuell halten:** Die Mods nutzen die Mod-Schnittstelle von 2.1.296. Ist `claude --version` älter,
   zuerst aktualisieren.
4. **Alle laufenden Claude-Sessions schliessen**, bevor der alte `mods`-Ordner umbenannt wird. Laufende Sessions laden
   einen Mod nicht neu, sie übernehmen ihn erst beim nächsten Start.

## Schritt 1: Alten Stand sichern und Repo holen (PowerShell)

```powershell
cd $env:USERPROFILE\.claude
if (Test-Path mods) { Rename-Item mods "mods-alt-$(Get-Date -Format yyyyMMdd)" }
git clone https://github.com/skaterino/claude-mods.git mods
# Nur falls clean-view gewünscht ist (eigenes, öffentliches Repo; steht in .gitignore dieses Repos):
git clone https://github.com/skaterino/claude-clean-view.git mods\clean-view
```

Der Ordner `%USERPROFILE%\.claude\mod-daten` (Marken, Limits, Backups) bleibt, wie er ist, nicht löschen.

**Prüfen:** `git -C $env:USERPROFILE\.claude\mods log --oneline -1` zeigt den neuesten Commit von GitHub, und es
gibt `mods\verbrauch\hooks\register.tsx` und `mods\sessions\liste.js`.

## Schritt 2: Mods prüfen lassen

```powershell
cd $env:USERPROFILE\.claude\mods\verbrauch; claude plugin validate .; claude plugin test .
cd $env:USERPROFILE\.claude\mods\sessions;  claude plugin validate .; claude plugin test .
```

**Prüfen:** beide Male `Validation passed` und `0 fail`. Schlägt etwas fehl, hier aufhören und Mike die Ausgabe
zeigen. Nichts am Code ändern, ohne dass Mike das will.

## Schritt 3: Laden über `settings.json`

Die Mods werden nicht mit `/plugin install` installiert. Claude Code lädt sie über die Umgebungsvariable
`CLAUDE_CODE_PLUGIN_DIRS` im `env`-Block von `%USERPROFILE%\.claude\settings.json`. Auf Windows werden die Ordner mit
**`;`** getrennt. Das ist im Code von Claude Code nachgelesen: Er trennt mit dem Pfad-Trennzeichen des Systems, auf dem
Mac ist es `:`.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:/Users/<Name>/.claude/mods/verbrauch;C:/Users/<Name>/.claude/mods/sessions;C:/Users/<Name>/.claude/mods/clean-view"
  }
}
```

- `<Name>` durch den echten Benutzerordner ersetzen (`echo $env:USERPROFILE`). In JSON Schrägstriche `/` nehmen, sonst
  muss jeder `\` als `\\` geschrieben werden.
- Claude Code nimmt auch Pfade, die mit `~` anfangen. Auf dem Mac steht dort `~/.claude/mods/...`, auf Windows ist das
  nicht getestet, daher absolute Pfade.
- Ohne clean-view den letzten Eintrag weglassen.
- Steht schon ein `env`-Block da, nur diesen einen Schlüssel ergänzen oder ersetzen, den Rest nicht anfassen.
- Der Auto-Mode-Klassifizierer blockt Änderungen an der `settings.json` durch Claude oft, weil er das als
  Selbständerung wertet. Dann Mike die Zeile geben und ihn bitten, sie selbst einzutragen.

## Schritt 4: Regeln in die globale `CLAUDE.md`

`/pause` und der Auto-Neustart schicken der Session Aufträge. Was Claude damit tun soll, steht nur in der globalen
`%USERPROFILE%\.claude\CLAUDE.md`. Den folgenden Abschnitt dort einfügen, falls er fehlt oder veraltet ist.
**Anpassen:** Der Memory-Pfad ist auf Windows ein anderer. Er ist der Projektordner mit allen Zeichen ausser
Buchstaben und Ziffern durch `-` ersetzt, plus `\memory\`. Den echten Ordner unter `%USERPROFILE%\.claude\projects\`
nachsehen, nicht raten.

```markdown
## Pause-Sicherung (`/pause`)

Kommt von einer anderen eigenen Session eine Nachricht mit `[PAUSE-SICHERN]`, hat Mike vor einer Pause `/pause`
ausgelöst (Mod `sessions`). Dann sofort den aktuellen Stand ins zuständige Memory schreiben, kurz, nur das Neue. Hat der
Auftrag mitten in einer Arbeit unterbrochen, danach dort weitermachen, falls noch etwas offen ist (das Sichern bricht
nichts ab); wurde auf Mike gewartet, danach nichts weiter tun und nicht von selbst loslegen. Nicht nachfragen und
nicht zurückschreiben.

„Wie beim MEMORY-HEARTBEAT“ bzw. „Memory-Arbeitsprozess“ heisst auf diesem Rechner: den Stand in die zuständige Datei der
Auto-Memory schreiben (`<MEMORY-ORDNER DIESES RECHNERS>`). Nennt die Nachricht eine **Zieldatei**, genau
dorthin (bei `/pause neu` startet die Session nur neu, wenn sie diese Datei selbst geschrieben hat). Sonst in die Datei,
die die Pickup-Phrase dieser Session laut 🔑-Zeile in `MEMORY.md` einliest; ohne Pickup-Phrase in die zuständige
Datei. `MEMORY.md` nur anfassen, wenn eine neue Datei entsteht.

**Auto-Neustart** (`/auto an`, Mod `verbrauch` + `sessions`): Beginnt eine Nachricht mit `Pause (Auto-Neustart):`, den
Stand wie oben sichern und genau eine Zeile `Auto-Weiter: ja — <nächster Schritt> [kennung]` oder
`Auto-Weiter: nein — <Grund> [kennung]` schreiben, mit der Kennung aus der Nachricht (alte Zeile immer ersetzen). Nach
dem Pickup mit `Auto-Neustart:`-Zusatz: Stand gegen git/Prod prüfen, bei `ja` ohne Rückfrage weiterarbeiten (Ausnahme
zu „nicht von selbst loslegen“), bei `nein` berichten und warten. Halt-Liste bleibt: was Mike sehen/abnehmen soll,
Plan-Entscheide, Geld, Rechtliches, Prod-Deploys → dort aufhören und Mike fragen.
```

**Pickup-Phrasen:** `/pause neu` und der Auto-Neustart starten nur Sessions neu, deren Pickup-Phrase in der `MEMORY.md`
eine 🔑-Zeile hat. Zum Beispiel: ``- [Webshop](project_webshop.md) — 🔑 `webshop pickup`: …``. Ohne solche
Zeilen sichert `/pause` nur und startet nicht neu, `/auto an` bleibt aus.

## Schritt 5: In einer neuen Session prüfen

Claude Code neu starten, dann:

1. `/verbrauch` öffnet das Pane mit Balken für 5 Stunden, 7 Tage, Kontext und Cache. Das Gleiche noch einmal schliesst es.
2. `/sessions` listet die laufenden Sessions. Steht dort eine Fehlermeldung zu `liste.js`, stimmt der Ort aus Schritt 1
   nicht.
3. Optional den Auto-Neustart in einer Session mit Pickup-Phrase prüfen: Im Pane steht `Auto-Neustart: ○ aus
   [ einschalten ]`. Nach `/auto an 300k 5` steht `● an · ab 300k · Kette 0/5 [ ausschalten ]`, in der Statuszeile 🔁.
   **Der Text zeigt den Zustand, der Knopf zeigt, was er tut.**

Ergebnis Mike kurz melden: was geht, und was nicht, mit der genauen Fehlermeldung.

## Bekannte Unterschiede auf Windows

- `/sessions` prüft mit dem Mac-Befehl `ps`, ob eine Prozessnummer inzwischen einem anderen Prozess gehört. `ps` gibt
  es auf Windows nicht. Der Mod fällt dann auf „läuft“ zurück. Eine beendete Session kann so als laufend erscheinen,
  wenn Windows ihre Nummer neu vergibt. Abgestürzt ist dabei nichts.
- Die Limits (5 Stunden und 7 Tage) gelten fürs ganze Konto. Jeder Rechner kennt aber nur den Stand seiner eigenen
  letzten API-Antwort (`mod-daten\verbrauch\limits.json`). Verbrauch vom Mac erscheint auf Windows also erst nach der
  nächsten Windows-Antwort.
- Benutzerverzeichnis: Die Mods nehmen `HOME` und, falls es fehlt, `USERPROFILE`. Gemischte `/` und `\` gehen.

## Weiterentwickeln

Nicht im geladenen Ordner arbeiten, denn jede neue Session lädt den Mod. Stattdessen:

1. Kopie nach `mod-daten\build\` machen.
2. Dort ändern, dann `claude plugin validate` und `claude plugin test`.
3. Einen Review-Agenten prüfen lassen.
4. Den alten Stand nach `mod-daten\backup\` sichern.
5. Die Kopie einspielen, ohne `.claude-plugin\types\claude-code-mcp\`, das wird generiert.
6. Hier committen und pushen, damit Mac und Windows denselben Stand haben.

Vor dem Arbeiten immer `git pull`, denn der Mac pusht auch.
