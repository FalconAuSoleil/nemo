#!/usr/bin/env bash
# Runs the two NVIDIA speech NIMs on one GPU: Nemotron ASR Streaming (:9000) and Magpie TTS (:9001).
# Usage on the GPU VM: NGC_API_KEY=nvapi-... bash start-nims.sh
set -euo pipefail
: "${NGC_API_KEY:?Set NGC_API_KEY (https://org.ngc.nvidia.com/setup/api-keys, scope: NGC Catalog)}"
ASR_IMAGE=${ASR_IMAGE:-nvcr.io/nim/nvidia/nemotron-asr-streaming:1.3.0}
TTS_IMAGE=${TTS_IMAGE:-nvcr.io/nim/nvidia/magpie-tts-multilingual:1.10.0}

if ! command -v docker >/dev/null; then
  sudo apt-get update && sudo apt-get install -y docker.io
  sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
fi
sudo usermod -aG docker "$USER" || true
DOCKER="sudo docker"

echo "$NGC_API_KEY" | $DOCKER login nvcr.io --username '$oauthtoken' --password-stdin
mkdir -p ~/.cache/nim-asr ~/.cache/nim-tts && chmod 777 ~/.cache/nim-asr ~/.cache/nim-tts

$DOCKER rm -f asr tts 2>/dev/null || true
$DOCKER run -d --name=asr --restart unless-stopped --runtime=nvidia --gpus '"device=0"' --shm-size=8GB \
  -e NGC_API_KEY -e NIM_HTTP_API_PORT=9000 -e NIM_GRPC_API_PORT=50051 \
  -e NIM_TAGS_SELECTOR="name=nemotron-asr-streaming,type=en-US,batch_size=32" \
  -v ~/.cache/nim-asr:/opt/nim/.cache -p 9000:9000 -p 50051:50051 "$ASR_IMAGE"

echo "Waiting for ASR (first start downloads models and may take 30+ minutes)..."
until curl -sf localhost:9000/v1/health/ready >/dev/null; do sleep 15; printf '.'; done; echo " ASR ready"

$DOCKER run -d --name=tts --restart unless-stopped --runtime=nvidia --gpus '"device=0"' --shm-size=8GB \
  -e NGC_API_KEY -e NIM_HTTP_API_PORT=9000 -e NIM_GRPC_API_PORT=50051 \
  -e NIM_TAGS_SELECTOR="name=magpie-tts-multilingual,batch_size=8" \
  -v ~/.cache/nim-tts:/opt/nim/.cache -p 9001:9000 -p 50052:50051 "$TTS_IMAGE"

echo "Waiting for TTS..."
until curl -sf localhost:9001/v1/health/ready >/dev/null; do sleep 15; printf '.'; done; echo " TTS ready"
curl -s localhost:9001/v1/audio/list_voices | head -c 400; echo
echo "Done. In Nemo's .env set NIM_ASR_URL=http://<this-ip>:9000 and NIM_TTS_URL=http://<this-ip>:9001"
echo "(or keep the ports private and use: ssh -N -L 9000:localhost:9000 -L 9001:localhost:9001 nemo@<this-ip>)"
