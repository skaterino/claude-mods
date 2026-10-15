# claude-mods

Mikes Mods für Claude Code, auf Deutsch. Entwickelt auf dem Mac mini, MIT-Lizenz.

| Mod | Version | Kurz |
|---|---|---|
| `verbrauch/` | 0.7.2 | Statuszeile + `/verbrauch`-Pane: 5-h-/7-Tage-Limits, Kontext, Cache-Sperre, Hintergrund-Agenten, Auto-Neustart (`/auto`) |
| `sessions/` | 0.4.1 | `/sessions`, `/pause` (sichern, `neu`, `selbst`, `auto`, `abbrechen`) |

`clean-view` hat ein eigenes öffentliches Repo: https://github.com/skaterino/claude-clean-view

## Laden

In `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/verbrauch:~/.claude/mods/sessions:~/.claude/mods/clean-view" }
```

Unter Windows Pfade mit `;` trennen. **Installation auf Windows Schritt für Schritt: [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).**

## Arbeiten

Nicht im geladenen Ordner entwickeln (jede Session lädt neu): Kopie bauen, `claude plugin validate` + `claude plugin test`, dann einspielen, hier committen und pushen.

Der Windows-Stand hat die Mac-Anpassungen (HOME vor USERPROFILE, `liste.js` mit `procStart`-Prüfung, geteilte Limits ab verbrauch 0.4.0) noch nicht. Dieses Repo ist die gemeinsame Quelle.
