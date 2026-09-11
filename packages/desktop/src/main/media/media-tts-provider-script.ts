/** Reviewed Host-owned entry point. Panel input is JSON data, never Python or shell source. */
export const MANAGED_TTS_SCRIPT = String.raw`
import asyncio, importlib.metadata, json, os, pathlib, re, socket, sys

request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
provider = request["providerId"]
action = request["action"]
def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

if provider == "edge-tts":
    import edge_tts
    async def edge():
        if action == "probe":
            emit({"result": {"version": importlib.metadata.version("edge-tts")}})
        elif action == "voices":
            voices = await edge_tts.list_voices()
            emit({"result": {"voices": [{"id": v["ShortName"], "name": v.get("FriendlyName", v["ShortName"]), "language": v["Locale"]} for v in voices]}})
        elif action == "generate":
            rate = f'{round((request["rate"] - 1) * 100):+d}%'
            speak = edge_tts.Communicate(request["text"], request["voiceId"], rate=rate)
            count = 0
            with open(request["output"], "wb") as output:
                async for chunk in speak.stream():
                    if chunk["type"] == "audio":
                        count += len(chunk["data"])
                        if count > 64 * 1024 * 1024:
                            raise ValueError("Audio exceeds its bounded download budget")
                        output.write(chunk["data"])
                        emit({"progress": {"stage": "speech", "message": "正在接收在线配音", "bytes": count}})
            emit({"result": {"bytes": count}})
        else:
            raise ValueError("Unsupported action")
    asyncio.run(edge())
elif provider == "kokoro":
    # Local generation must never silently fetch a model or contact an online provider.
    def offline(*args, **kwargs):
        raise RuntimeError("Kokoro synthesis is offline; network access is disabled")
    socket.create_connection = offline
    socket.socket.connect = offline
    socket.socket.connect_ex = offline
    import numpy as np
    import kokoro_onnx
    import soundfile as sf
    from misaki.zh import ZHG2P
    if action == "probe":
        emit({"result": {"version": importlib.metadata.version("kokoro-onnx"), "frontend": importlib.metadata.version("misaki")}})
    elif action == "voices":
        with np.load(request["voicesPath"], allow_pickle=False) as voices:
            supported = []
            for name in sorted(voices.files):
                language = "zh-CN" if name.startswith("z") else "en-US" if name.startswith("a") else "en-GB" if name.startswith("b") else None
                if language:
                    supported.append({"id": name, "name": name, "language": language})
            emit({"result": {"voices": supported}})
    elif action == "generate":
        import onnxruntime as ort
        from kokoro_onnx.tokenizer import Tokenizer
        config = ort.SessionOptions()
        config.intra_op_num_threads = min(4, os.cpu_count() or 1)
        config.inter_op_num_threads = 1
        session = ort.InferenceSession(request["modelPath"], sess_options=config, providers=["CPUExecutionProvider"])
        model = kokoro_onnx.Kokoro.from_session(session, request["voicesPath"])
        voice = request["voiceId"]
        segments = [s.strip() for s in re.split(r"(?<=[。！？.!?；;])|\n+", request["text"]) if s.strip()]
        parts = []
        frames = 0
        zh = ZHG2P() if voice.startswith("z") else None
        for index, segment in enumerate(segments):
            if zh:
                # Keep English insertions pronounceable instead of passing Latin letters as IPA.
                phonemes = ""
                for piece in re.findall(r"[A-Za-z][A-Za-z '\-]*|[^A-Za-z]+", segment):
                    phonemes += (model.tokenizer.phonemize(piece, "en-us") if re.match(r"[A-Za-z]", piece) else zh(piece)[0]) + " "
                samples, sr = model.create(phonemes, voice=voice, speed=request["rate"], is_phonemes=True)
            else:
                if re.search(r"[\u4e00-\u9fff]", segment):
                    raise ValueError("Choose a Chinese voice for Chinese text")
                samples, sr = model.create(segment, voice=voice, speed=request["rate"], lang="en-gb" if voice.startswith("b") else "en-us")
            frames += len(samples)
            if frames > 24000 * 1800:
                raise ValueError("Speech exceeds 30 minutes")
            parts.append(samples)
            emit({"progress": {"fraction": 0.1 + 0.7 * (index + 1) / len(segments), "stage": "speech", "message": "正在本地生成配音"}})
        if not parts:
            raise ValueError("No spoken text")
        audio = np.concatenate(parts)
        if not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.0001:
            raise ValueError("Speech output is empty or silent")
        sf.write(request["output"], audio, 24000, subtype="PCM_16")
        emit({"result": {"durationSeconds": len(audio) / 24000}})
    else:
        raise ValueError("Unsupported action")
else:
    raise ValueError("Unsupported provider")
`;
