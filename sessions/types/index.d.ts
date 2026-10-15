/** Eine laufende Claude-Session dieses Rechners, wie liste.js sie liest. */
export type Session = {
  pid: number
  sessionId: string
  /** Der Name, unter dem andere Sessions sie erreichen (SendMessage). */
  name: string
  /** `interactive` oder `bg`. */
  kind: string
  /** `busy` oder `idle`. */
  status: string
  version: string
  cwd: string
  startedAt: number
  /** Zeitpunkt der letzten Antwort im Haupt-Loop (ms), die Cache-Uhr; 0 unbekannt. */
  lastApiAt: number
  /** Kontext bei der letzten Antwort in Tokens; 0 unbekannt. */
  context: number
  /** Pickup-Phrase oder Anfang des ersten eigenen Prompts. */
  topic: string
  /** Pickup-Phrase, '' wenn keine. */
  pickup: string
  /** Läuft der Mod dort (Marke beim Start gesetzt)? Nur dann kann sie sich nach /pause neu selbst neu starten. */
  hasMod: boolean
}

/** Wohin eine Session ihren Stand sichert: die Datei, die ihre Pickup-Phrase laut MEMORY.md einliest. */
export type Anchor = {
  /** Die Pickup-Phrase, wie MEMORY.md sie schreibt; '' wenn keine. */
  phrase: string
  /** Absoluter Pfad der Datei; '' wenn die Phrase in MEMORY.md nicht vorkommt. */
  file: string
}

/** Vorgemerkter Neustart nach /pause neu. */
export type Restart = Anchor & {
  /** Der Sicherungs-Turn (turn.start nach dem Auftrag); '' solange er nicht begonnen hat. */
  turn: string
  /** Wann vorgemerkt (ms): eine Vormerkung ohne begonnenen Sicherungs-Turn verfällt für /pause selbst nach 60 s. */
  at: number
  /** Was die Session zuletzt selbst in die Zieldatei schrieb (Write, Edit, Bash); muss am Ende noch drinstehen. */
  proof: string[]
  /**
   * /pause auto (Auto-Neustart des verbrauch-Mods): nach dem Nachweis zählt die Auto-Weiter-Zeile, und die Phrase
   * wird abgeschickt statt nur ins Feld gelegt. Fehlt bei /pause neu und /pause selbst.
   */
  auto?: true
  /**
   * Nur bei /pause auto: die Kennung dieser Sicherung (4 Hex-Zeichen). Der Auftrag nennt sie; nur eine Auto-Weiter-Zeile
   * mit `[Kennung]` zählt als ja oder nein, auch wenn sie sonst Wort für Wort einer älteren gleicht.
   */
  token?: string
}

export type Overview = {
  /** Zeitpunkt des Einlesens (ms); 0 noch nie. */
  at: number
  list: Session[]
  /** Warum nichts gelesen werden konnte; '' wenn alles gut ging. */
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    sessions: {
      overview: Overview
      /** Wem /pause die Sicherung aufgetragen hat: Session-ID → Zeitpunkt (ms). */
      asked: Record<string, number>
      /** Neustart nach dem laufenden Turn, sofern die Zieldatei geschrieben wurde; null heisst kein Neustart. */
      restart: Restart | null
    }
  }
}
