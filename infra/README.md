# Infra: NVIDIA speech NIMs on Nebius AI Cloud

Nemo's ears and voice are two NVIDIA NIM microservices running on one L40S GPU VM.

| Service | NIM image | Port | GPU memory |
|---|---|---|---|
| Speech-to-text | `nvcr.io/nim/nvidia/nemotron-asr-streaming:1.3.0` (profile `type=en-US,batch_size=32`) | 9000 (HTTP + realtime WebSocket) | ~6 GB |
| Text-to-speech | `nvcr.io/nim/nvidia/magpie-tts-multilingual:1.10.0` (profile `batch_size=8`) | 9001 | ~12.6 GB |

The two NIMs need about 19 GB in total, so they fit on a 48 GB L40S. An L40S on demand costs about $1.35/h in eu-north1, so stop the VM when you are not using it.

## Steps
1. Get an NGC API key: https://org.ngc.nvidia.com/setup/api-keys. Generate a personal key with the "NGC Catalog" scope. NIMs are free for development under the NVIDIA Developer Program.
2. Create the VM. You need the `nebius` CLI and a quota for 1 L40S in eu-north1:
   ```bash
   bash infra/create-vm.sh
   ```
   You can also do it in the console: platform `gpu-l40s-a`, preset `1gpu-16vcpu-64gb`, image `ubuntu24.04-cuda13.0`, 250 GiB network SSD, public IP.
3. Start the NIMs on the VM:
   ```bash
   scp infra/start-nims.sh nemo@<ip>:
   ssh nemo@<ip> 'NGC_API_KEY=nvapi-... bash start-nims.sh'
   ```
   The first start downloads the models and can take 30–45 minutes. Later starts use the cache.
4. Point Nemo at the NIMs. The default security group is open; for private ports, use an SSH tunnel instead:
   ```bash
   ssh -N -L 9000:localhost:9000 -L 9001:localhost:9001 nemo@<ip>
   # .env
   NIM_ASR_URL=http://localhost:9000
   NIM_TTS_URL=http://localhost:9001
   ```
5. Run `npm run check` from the repo root to verify every integration.

## Fallback
If a NIM is not reachable, Nemo falls back to the browser's speech recognition and synthesis (Chrome). The brain (Nemotron on Token Factory) and the research (Tavily) keep running.
