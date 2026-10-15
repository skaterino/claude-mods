export type Warned = {
  /** Kontextstufe, die schon gemeldet wurde: 0 keine, 1 über WARN, 2 über ALARM. */
  context: number
  /** Je Limit-Fenster (`five_hour`, `seven_day`): `<resetsAt>|<prozent>` der letzten Meldung. */
  limits: Record<string, string>
}

/** Ein Limit-Fenster, wie `$.session.usage()` es meldet, oder die geteilte Messung einer Session. */
export type Limit = {
  kind: string
  percent: number
  resetsAt?: string
  /** Wann gemessen (ms), also wann die API-Antwort kam; fehlt, wenn unbekannt. */
  at?: number
  /** Session, aus deren API-Antwort der Wert stammt; fehlt, wenn unbekannt. */
  session?: string
}

/** Der letzte gelesene Stand, aus dem das Pane zeichnet. */
export type Snapshot = {
  /** Wann gelesen (ms); 0 noch nie. */
  at: number
  limits: Limit[]
  /** Kontext in Tokens; fehlt vor der ersten Antwort. */
  tokens?: number
  /** Kontextfenster des Modells in Tokens. */
  window: number
  /** API-Gegenwert der Session in USD, wie /cost ihn zählt. */
  usd?: number
  /** Beginn der Session (ms). */
  startedAt: number
  /** Ende des letzten Haupt-Turns (ms); 0 noch keiner. */
  lastTurn: number
  /** Ein Turn läuft gerade: der Cache wird laufend genutzt. */
  running: boolean
  /** Pickup-Phrase und -Datei laut Marke des sessions-Mods; null wenn der Mod hier nicht läuft. */
  pickup?: Pickup | null
  /** Der Auto-Neustart dieser Session, wie er im Store steht; null ohne Eintrag (aus, Standardwerte). */
  auto?: Auto | null
}

/**
 * Auto-Neustart einer Session, im Store unter `auto:<sessionId>`: Atome leert ein /clear, der Store bleibt, und
 * der Eintrag zieht auf die neue ID um. Werte gelten pro Session.
 */
export type Auto = {
  /** Eingeschaltet. */
  an: boolean
  /** Ab so viel Kontext (Tokens) löst er am Turn-Ende aus. */
  grenze: number
  /** Höchstens so viele Auto-Neustarts in Folge ohne Prompt von Mike. */
  max: number
  /** Auto-Neustarts seit dem letzten Prompt (Tastatur oder Telefon) oder /clear von Mike. */
  kette: number
  /** Beginn des letzten Auto-Neustarts (ms); 0 noch keiner. */
  letzter: number
  /** Letzte Änderung (ms): danach räumt der Mod alte Einträge auf. */
  at: number
}

/** Was der sessions-Mod in seiner Marke über die Pickup-Datei dieser Session festhält; '' wenn keine. */
export type Pickup = { phrase: string; file: string }

/** Ein Agent-Loop dieser Session, wie der Mod ihn sieht: aus `$.agent.list()` und den eigenen API-Aufrufen. */
export type AgentRow = {
  id: string
  /** Die paar Worte des Agent-Aufrufs; '' für einen Loop ohne Listeneintrag (Workflow, interner Fork). */
  description: string
  /** Agent-Typ (`Explore`, `general-purpose`, ...); '' ohne Listeneintrag. */
  type: string
  /**
   * AgentStatus laut Liste; `gone`, wenn er aus der Liste fiel, ohne dass ein Ende zu sehen war;
   * `unlisted` für einen Loop, den die Liste nie nannte.
   */
  status: string
  /** Wann zuerst gesehen (ms), in der Liste oder beim ersten API-Aufruf. */
  startedAt: number
  /** Wann zuerst als beendet gesehen (ms); fehlt, solange er läuft. */
  endedAt?: number
  /** Letzter API-Aufruf (ms); 0 noch keiner. */
  lastCallAt: number
  /** API-Aufrufe seit dem Laden des Mods. */
  calls: number
  /** API-Gegenwert in USD aus den gezählten Tokens. */
  usd: number
  /** Ein Aufruf lief auf einem Modell ohne Preis in der Tabelle: `usd` ist dann zu tief. */
  unpriced: boolean
  /** Ausgegebene Tokens. */
  outputTokens: number
  /** Modell des letzten Aufrufs. */
  model?: string
}

/** Eine Hintergrund-Arbeit ohne eigenen Loop: Shell, Monitor, Workflow. */
export type ShellRow = {
  id: string
  /** `shell`, `monitor`, `workflow`, ... wie die Engine sie nennt. */
  kind: string
  description: string
  startedAt: number
  endedAt?: number
}

/** Was im Hintergrund läuft und lief, samt Kosten je Agent. */
export type Background = {
  agents: Record<string, AgentRow>
  shells: Record<string, ShellRow>
  /** Kosten des Haupt-Loops seit Beginn der Zählung. */
  main: { calls: number; usd: number; unpriced: boolean }
  /** Beginn der Zählung (ms) und der API-Gegenwert der Engine in diesem Moment, zum Abgleich. */
  since?: { at: number; usd: number; from?: number }
  /** Kosten der Agenten, die über BG_KEEP herausgefallen sind: bleiben in der Summe. */
  prunedUsd?: number
  /**
   * Wie oft die Engine nach einem Turn einen Vorschlag fürs Eingabefeld erzeugt hat. Jeder kostet einen
   * Modell-Aufruf über den ganzen Kontext, der an keinem `turn.step` vorbeikommt: der Hauptteil dessen,
   * was die Engine mehr zählt als der Mod (live gemessen 2026-10-14: ~$0.06 je Turn-Ende bei 280k).
   */
  suggestions?: number
}

declare module 'claude-code' {
  interface PluginState {
    verbrauch: {
      warned: Warned
      /** Ende des Haupt-Turns (ms), nach dem die Cache-Sperre schon einmal angehalten hat; 0 noch nie. */
      held: number
      snap: Snapshot
      /** Bis wann (ms) der zweite Druck auf „Sichern & neu starten“ gilt; 0 kein erster Druck. */
      confirm: number
      /** Hintergrund-Agenten und -Shells dieser Session mit ihren Kosten. */
      bg: Background
      /** Sekunden bis zum Auto-Neustart, solange der Countdown läuft; 0 kein Countdown. */
      countdown: number
    }
  }
}
