# Nemo: brainstorm out loud

**Nemo is a voice-first AI facilitator for group brainstorming.** Put one computer in the room. Nemo listens to the conversation and turns every idea into a card on a shared canvas. It runs web research in parallel while you keep talking, and it speaks up only when it can actually move the group forward.

Nobody touches the canvas: **Nemo is the only one who edits it**. People steer it by voice ("Hey Nemo, merge 3 and 7", "Nemo, explore pre-ordering systems", "Nemo, let's do SCAMPER on 4"). Anyone can watch the live board on their own device with a 4-letter room code.

Built for the **Nebius x NVIDIA Global AI Hackathon** (track: Best Apps and Agents).

### 3min video: https://youtu.be/PuRhZA92lrk

---

## Voice commands (examples)

- "Hey Nemo, today we're brainstorming how might we cut food waste in the cafeteria."
- "Nemo, merge 2 and 3", "rename 4 to smart scales", "move 5 and 7 to Pricing", "delete 6"
- "Nemo, look up how much food a canteen wastes per meal"
- "Nemo, explore pre-ordering systems in workplace canteens" (starts parallel sub-agents)
- "Nemo, let's do SCAMPER on 2", "six thinking hats", "a pre-mortem on 4"
- "Nemo, vote for 2, 6 and 10", "move on", "wrap up", "Nemo, stop"

## How Nemo uses NVIDIA models and Nebius

| Role | Model | Where it runs |
|---|---|---|
| Brain: intent routing, idea extraction, canvas commands, spoken replies (tool calling, thinking off for latency) | **NVIDIA Nemotron 3.5 Lightning** (`nvidia/Nemotron-3_5-Lightning`) | **Nebius Token Factory** |
| Facilitation coach, parallel research sub-agents, session summary | **NVIDIA Nemotron 3 Super 120B-A12B** (`nvidia/nemotron-3-super-120b-a12b`) | **Nebius Token Factory** |
| Ears: streaming speech-to-text, with word boosting for "Nemo" | **NVIDIA Nemotron ASR Streaming** NIM | **Nebius AI Cloud** (L40S VM) |
| Voice: streaming text-to-speech | **NVIDIA Magpie TTS Multilingual** NIM | **Nebius AI Cloud** (same VM) |
| Real-time web intelligence: fact checks, market data, competitors | **Tavily** Search API | Tavily |

All LLM calls go through Token Factory's chat-completions API. Thinking is switched off on the voice path with `chat_template_kwargs.enable_thinking=false`, and structured decisions use named tool calls. See [`infra/README.md`](infra/README.md) to deploy the speech NIMs on a Nebius GPU VM.

## Architecture (hexagonal)

```
                 ┌──────────────── driving adapters ────────────────┐
  Room PC (mic + │ WebSocket gateway: host audio / text, viewers,   │
  speakers)  ───▶│ controls · HTTP: static client, summary export   │
  Viewers    ───▶│ DemoDirector (scripted conversation)             │
                 └───────────────┬──────────────────────────────────┘
                                 ▼
  ┌─────────────────────── application ───────────────────────────┐
  │ Room (use cases): handleFinal / handlePartial / playback / ctl │
  │  ├─ Brain (Nemotron Lightning): one tool call per utterance    │
  │  ├─ Research lane (p-queue x3): Tavily, then a fact card       │
  │  ├─ Explorer: orchestrator + parallel sub-agents (Super)       │
  │  ├─ Coach (Super): stalls, phases, clustering, challenges      │
  │  └─ Speaker: priority queue, breakpoints, half-duplex          │
  │ Ports: LanguageModel · WebSearch · SpeechToText ·              │
  │        TextToSpeech · RoomPublisher · Clock                    │
  └─────────────────────────┬──────────────────────────────────────┘
  ┌──────────── domain (pure TypeScript, no I/O) ───────────────────┐
  │ Canvas aggregate (single writer, numbering, dedup, ownership) · │
  │ Session (phase machine, room signals, method runner) ·          │
  │ InterruptionBudget · wake-word detection · facilitation playbook│
  └─────────────────────────────────────────────────────────────────┘
                 ┌──────────────── driven adapters ─────────────────┐
                 │ Nemotron (Token Factory) · Tavily ·              │
                 │ NIM ASR realtime WS · Magpie TTS streaming ·     │
                 │ offline fakes (rule-based LLM, canned search)    │
                 └──────────────────────────────────────────────────┘
```

- The voice loop never waits on research. The ASR stream feeds an event bus, and research and sub-agents run in their own queues.
- All canvas writes go through the single `Canvas` aggregate. It assigns card numbers, dedupes cards, and keeps each sub-agent inside its own lane.
- The browser canvas is **read-only**: React Flow, with an elkjs layout that keeps cards stable as new ones arrive. It receives snapshots plus versioned ops over WebSocket.

## Quick start

Requirements: Node 22+ and Chrome.

```bash
npm install
cp .env.example .env        # add NEBIUS_API_KEY and TAVILY_API_KEY (and the NIM URLs if you have the GPU VM)
npm run check               # verifies Token Factory, Tavily and the NIMs
npm run dev                 # server on :8787, client on http://localhost:5173
```

Open http://localhost:5173 and click **Start session**, then **Start listening**. Then just talk. Viewers open `/join` on any device and enter the room code.

Production build (one process serves the client and the API):

```bash
npm start                   # http://localhost:8787
# or
docker build -t nemo . && docker run -p 8787:8787 --env-file .env nemo
```

## License

MIT
