# Integration notes (research of 2026-10-02)

## Nebius Token Factory (Nemotron)
- base_url `https://api.tokenfactory.nebius.com/v1/`, `Authorization: Bearer $NEBIUS_API_KEY`.
- IDs: `nvidia/Nemotron-3_5-Lightning` (eu-north1, ~314 tok/s, 0.06/0.24 $/M), `nvidia/nemotron-3-super-120b-a12b` (us-central1, 0.30/0.90), `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/Nemotron-3-Ultra-550b-a55b`.
- Thinking off: `chat_template_kwargs: { enable_thinking: false }` at the body root (fallback `extra_body`). `/no_think` does nothing. `low_effort: true` only on Super.
- With thinking on, Lightning takes ~8.5 s before the first answer token. Keep it off on the voice path.
- Tool calling uses the OpenAI format (qwen3_coder parser). Prefer flat schemas and pass nested objects as JSON strings. Named `tool_choice` should be constrained. `response_format: json_schema` is NOT tagged for Nemotron.
- Sampling: Super/Lightning temperature 1.0, top_p 0.95 (NVIDIA). Use 0.2–0.6 for router/extractor.
- Rate limits are dynamic, base example 60 RPM. Watch the `x-ratelimit-*` headers and honour Retry-After.

## Tavily
- `POST https://api.tavily.com/search` and `/extract`, `Authorization: Bearer tvly-...`.
- search_depth: `ultra-fast`|`fast`|`basic` = 1 credit, `advanced` = 2. Params: `max_results` (0-20), `chunks_per_source` (1-3), `topic` general|news, `time_range`, `include_answer`.
- Rate limit is 100 RPM on a dev key. Free plan is 1000 credits/month. The Devpost prize "Best Use of Tavily" ($3k) requires a runtime call.

## NIM ASR — nemotron-asr-streaming:1.3.0 (port 9000)
- Profile `name=nemotron-asr-streaming,type=en-US,batch_size=32` uses 6 GB.
- 1. `POST /v1/realtime/transcription_sessions` with `{}`. It returns the default session and maybe `client_secret`.
- 2. WS `ws://HOST:9000/v1/realtime?intent=transcription`. If there is a secret, pass protocols `["realtime","realtime-token.<v>"]`.
- 3. The server sends `conversation.created`. Send `transcription_session.update` with the session returned by the POST, overriding:
  - `input_audio_format: "pcm16"`
  - `input_audio_transcription.language: "en-US"`
  - `input_audio_params: {sample_rate_hz:16000, num_channels:1}`
  - `recognition_config.enable_automatic_punctuation: true`
  - `word_boosting: {enable_word_boosting:true, word_boosting_list:[{phrases:[...], boost:1.5}]}` (RNNT boost range 0.5–2.0)
- 4. For each chunk send `{"type":"input_audio_buffer.append","audio":"<b64 pcm16le>"}`, then `{"type":"input_audio_buffer.commit"}`. The server times out after 60 s idle and caps a session at 3600 s.
- 5. Server messages: `conversation.item.input_audio_transcription.delta {delta}` and `...completed {transcript, words_info, is_last_result}`. Log the raw events: the delta/completed semantics are not fully documented.

## NIM TTS — magpie-tts-multilingual:1.10.0 (host port 9001)
- Profile `batch_size=8` uses 12.6 GiB. Native output is 22050 Hz.
- Simplest: `POST /v1/audio/synthesize_online` (multipart: text, language=en-US, voice, sample_rate_hz=22050, encoding=LINEAR_PCM). It returns a chunked raw s16le mono stream. Max 2000 chars.
- Voices: `Magpie-Multilingual.EN-US.{Aria,Mia,Jason,Leo,Sofia,Ray}[.Neutral|.Calm|...]`, and `Jason.Happy`.
- `GET /v1/audio/list_voices`.

## NIM deployment on Nebius L40S (eu-north1)
- See `infra/README.md`. Image family `ubuntu24.04-cuda13.0`. Platform `gpu-l40s-a` with preset `1gpu-16vcpu-64gb`. Disk 250 GiB.
- The first start takes up to 30–45 min (model download and TensorRT build). Cache: `-v ~/.cache/nim-*:/opt/nim/.cache`.
- NGC key: org.ngc.nvidia.com/setup/api-keys, then `docker login nvcr.io -u '$oauthtoken'`.

## Browser
- Chrome on localhost is a secure context. `new AudioContext({sampleRate:16000})` resamples natively.
- Half-duplex: mute the mic while TTS plays, plus 400 ms of tail.
