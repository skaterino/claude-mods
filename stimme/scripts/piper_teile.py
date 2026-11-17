"""Erzeugt die Abschnitte einer Vorlesung als WAV-Dateien mit einer Piper-Stimme (piper-tts 1.8).

Die Abschnitte kommen als UTF-8 über stdin, getrennt durch das Zeichen 0x1E. Abschnitt i landet als
<ordner>/<praefix>-<i>.wav (erst als .tmp geschrieben, dann umbenannt, damit der Abspieler nie eine halbe
Datei öffnet). Das Modell wird nur einmal geladen; die Erzeugung läuft dem Abspielen voraus.

Hört auf, sobald die Steuerdatei "stopp" enthält oder der aufrufende Prozess (--eltern) nicht mehr lebt;
dann räumt es seine Dateien weg.
"""

import argparse
import ctypes
import glob
import os
import sys
import wave

from piper import PiperVoice, SynthesisConfig


def eltern_lebt(pid: int) -> bool:
    if pid <= 0:
        return True
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not h:
        return False
    try:
        return k32.WaitForSingleObject(h, 0) == 0x102  # WAIT_TIMEOUT = läuft noch
    finally:
        k32.CloseHandle(h)


def lies(pfad: str) -> str:
    try:
        with open(pfad, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def tempo(pfad: str) -> float:
    try:
        t = float(lies(pfad))
        if 0.5 <= t <= 4:
            return t
    except ValueError:
        pass
    return 1.0


def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("--modell", required=True)
    a.add_argument("--ordner", required=True)
    a.add_argument("--praefix", required=True)
    a.add_argument("--steuerung", required=True)
    a.add_argument("--tempo", required=True)
    a.add_argument("--eltern", type=int, default=0)
    args = a.parse_args()

    teile = [t for t in sys.stdin.buffer.read().decode("utf-8").split("\x1e")]
    voice = PiperVoice.load(args.modell)

    def aufraeumen() -> None:
        for f in glob.glob(os.path.join(args.ordner, f"{args.praefix}-*")):
            try:
                os.remove(f)
            except OSError:
                pass

    for i, teil in enumerate(teile):
        if lies(args.steuerung) == "stopp" or not eltern_lebt(args.eltern):
            aufraeumen()
            return 0
        ziel = os.path.join(args.ordner, f"{args.praefix}-{i}.wav")
        tmp = ziel + ".tmp"
        if teil.strip():
            config = SynthesisConfig(length_scale=1.0 / tempo(args.tempo))
            with wave.open(tmp, "wb") as wf:
                voice.synthesize_wav(teil, wf, syn_config=config)
        else:
            with wave.open(tmp, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(22050)
        os.replace(tmp, ziel)
    return 0


if __name__ == "__main__":
    sys.exit(main())
