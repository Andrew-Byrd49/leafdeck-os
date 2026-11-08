#!/usr/bin/env python3
# Speech to text for electron/voice.cjs: whisper.cpp through Fedora's python3-pywhispercpp (the whisper-cpp package is
# the library alone, with no command). The model is loaded once, then each request on stdin, one JSON object per line
# ({"id": 1, "file": "/path/to.wav"}), is answered on stdout ({"id": 1, "text": "..."} or {"id": 1, "error": "..."}).
# Audio is read here with the standard library (16 kHz mono 16-bit WAV, as voice.cjs writes it), so nothing beyond
# the bindings and numpy is needed.
#   usage: whisper-helper.py <model file> <threads>
import json
import sys
import wave


def main():
    model_file, threads = sys.argv[1], int(sys.argv[2])
    try:
        import numpy as np
        from pywhispercpp.model import Model
    except Exception as err:  # the package isn't there: say so on the first request
        print(json.dumps({"error": f"python3-pywhispercpp isn’t installed ({err})"}), flush=True)
        return
    kwargs = dict(n_threads=threads, print_progress=False, print_realtime=False, language="en")
    try:
        model = Model(model_file, redirect_whispercpp_logs_to=None, **kwargs)
    except TypeError:  # an older binding without the log option
        model = Model(model_file, **kwargs)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        try:
            with wave.open(req["file"], "rb") as w:
                frames = w.readframes(w.getnframes())
            audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            segments = model.transcribe(audio)
            text = " ".join(s.text.strip() for s in segments if s.text and s.text.strip())
            print(json.dumps({"id": rid, "text": text}), flush=True)
        except Exception as err:
            print(json.dumps({"id": rid, "error": str(err)}), flush=True)


if __name__ == "__main__":
    main()
