# Nemo: brainstorm out loud

**Nemo is a voice-first AI facilitator for group brainstorming.** Put one computer in the room. Nemo listens to the conversation and turns every idea into a card on a shared canvas. It runs web research in parallel while you keep talking, and it speaks up only when it can actually move the group forward.

Nobody touches the canvas: **Nemo is the only one who edits it**. People steer it by voice ("Hey Nemo, merge 3 and 7", "Nemo, explore pre-ordering systems", "Nemo, let's do SCAMPER on 4"). Anyone can watch the live board on their own device with a 4-letter room code.

Built for the **Nebius x NVIDIA Global AI Hackathon** (track: Best Apps and Agents).

---

## How Nemo uses NVIDIA models and Nebius

| Role | Model | Where it runs |
|---|---|---|
| Brain: intent routing, idea extraction, canvas commands, spoken replies (tool calling, thinking off for latency) | **NVIDIA Nemotron 3.5 Lightning** (`nvidia/Nemotron-3_5-Lightning`) | **Nebius Token Factory** |
| Facilitation coach, parallel research sub-agents, session summary | **NVIDIA Nemotron 3 Super 120B-A12B** (`nvidia/nemotron-3-super-120b-a12b`) | **Nebius Token Factory** |
| Ears: streaming speech-to-text, with word boosting for "Nemo" | **NVIDIA Nemotron ASR Streaming** NIM | **Nebius AI Cloud** (L40S VM) |
| Voice: streaming text-to-speech | **NVIDIA Magpie TTS Multilingual** NIM | **Nebius AI Cloud** (same VM) |
| Real-time web intelligence: fact checks, market data, competitors | **Tavily** Search API | Tavily |

All LLM calls go through Token Factory's chat-completions API. Thinking is switched off on the voice path with `chat_template_kwargs.enable_thinking=false`, and structured decisions use named tool calls. See [`infra/README.md`](infra/README.md) to deploy the speech NIMs on a Nebius GPU VM.

## What it does

- **Captures everything.** Ideas, concerns and questions become numbered cards a few seconds after they are said. Near-duplicate cards are merged automatically, so nobody has to hold an idea in their head while waiting to speak (that wait is called "production blocking").
- **Understands voice commands about the board.** You can say: merge, rename, delete, move, group, link, vote, "break down #4", change the topic, move to the next phase, wrap up, or stop.
- **Researches in parallel without blocking the talk.**
  - An unsourced claim ("half of cafeteria food is thrown away") triggers a quiet Tavily check. The sourced result appears as a fact card and a discreet pop-up.
  - "Nemo, explore X" launches **parallel research sub-agents**, one per angle (existing solutions, user needs, constraints…). Each one writes into its own lane of the canvas as it finds things.
- **Facilitates like a pro.** A session moves through phases: *Frame → Diverge → Cluster → Deepen → Challenge → Converge → Wrap-up*. Nemo applies a facilitation playbook built from published research ([`server/src/domain/playbook.json`](server/src/domain/playbook.json)):
  - It runs methods step by step (SCAMPER, Six Thinking Hats, Reverse brainstorming, 5 Whys, Worst Possible Idea, Starbursting, Pre-mortem, dot voting…).
  - It spots stalls (long silence, ideas drying up, the group agreeing too fast) and proposes the right method.
  - It clusters the board and asks Socratic challenge questions only when the group is converging.
- **BrainMaster mode (default).** Nemo leads like a sharp facilitator:
  - Every ~12 s it checks the room for methodological gaps (one angle only, no user view, no risks, ideas too safe, consensus too fast, nothing prioritised).
  - It starts the right method itself, and about once a minute it challenges one specific idea with a Socratic question.
  - `NEMO_STYLE=calm` gives the discreet version, which asks before acting.
- **Knows when to shut up.** An **interruption budget** (a token bucket) limits unsolicited interventions:
  - Proactive lines wait for a natural pause in the conversation.
  - Non-urgent findings go to silent pop-ups.
  - Every intervention shows its **"Why now?"** signal.
  - Nemo holds back its own ideas until the humans have produced several of theirs, to avoid anchoring the group on AI ideas.
- **Wraps up.** At the end, Nemo produces a summary: top ideas, themes, risks, open questions, next steps and sources. You can export it as Markdown.

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

### Modes

| What you configure | Speech | Voice | Brain | Web |
|---|---|---|---|---|
| Everything | NVIDIA Nemotron ASR NIM | NVIDIA Magpie TTS NIM | Nemotron on Token Factory | Tavily |
| Only `NEBIUS_API_KEY` and `TAVILY_API_KEY` | Chrome Web Speech | Chrome speech synthesis | Nemotron | Tavily |
| Nothing (offline demo) | Chrome Web Speech | Chrome speech synthesis | rule-based offline brain | canned offline results |

The **Demo** button plays a scripted conversation through the real pipeline, with live models when keys are set. It is useful to rehearse or to record a video without a room. You can also type what someone said instead of speaking.

## Voice commands (examples)

- "Hey Nemo, today we're brainstorming how might we cut food waste in the cafeteria."
- "Nemo, merge 2 and 3", "rename 4 to smart scales", "move 5 and 7 to Pricing", "delete 6"
- "Nemo, look up how much food a canteen wastes per meal"
- "Nemo, explore pre-ordering systems in workplace canteens" (starts parallel sub-agents)
- "Nemo, let's do SCAMPER on 2", "six thinking hats", "a pre-mortem on 4"
- "Nemo, vote for 2, 6 and 10", "move on", "wrap up", "Nemo, stop"

## Tests

```bash
npm test
```

The tests cover:
- the domain (canvas, wake word, budget, phases and methods);
- the full room pipeline with offline adapters (ideas, commands, parallel research, sub-agents);
- every real adapter against protocol mocks: Nemotron on Token Factory (including the 400 fallbacks), the NIM realtime ASR WebSocket, Magpie chunked PCM, and Tavily.

## Project layout

```
shared/   wire protocol (types shared by client and server)
server/   domain/ · application/ (room, agents, ports) · adapters/ (inbound, outbound, fakes) · main.ts
client/   Vite + React + React Flow + Tailwind v4 + Motion + Phosphor icons
infra/    Nebius GPU VM + NVIDIA speech NIM scripts
docs/     research notes (facilitation playbook, integration notes)
```

## Research behind the design

- Facilitation playbook: Osborn and IDEO rules; Diehl & Stroebe 1987 (production blocking); Wadinambiarachchi et al. CHI 2024 (AI-induced fixation); Doshi & Hauser 2024 (diversity loss); Lee et al. CHI 2025 (devil's advocate); Alsobay et al. 2025 (LLM facilitation).
- Proactive timing: Liu et al. CHI 2025 "Inner Thoughts"; Horvitz CHI 1999 (mixed-initiative interfaces).
- Parallel sub-agents: orchestrator-worker pattern (Anthropic multi-agent research); NVIDIA AI-Q.

## License

MIT
