#!/usr/bin/env bash
# Creates a Nebius AI Cloud VM with one L40S GPU (eu-north1) for the NVIDIA speech NIMs.
# Prerequisites: nebius CLI configured (`nebius profile create`), jq, an SSH key in ~/.ssh/id_ed25519.pub
set -euo pipefail
NAME=${NAME:-nemo-speech}
PLATFORM=${PLATFORM:-gpu-l40s-a}
PRESET=${PRESET:-1gpu-16vcpu-64gb}
IMAGE_FAMILY=${IMAGE_FAMILY:-ubuntu24.04-cuda13.0}
DISK_GIB=${DISK_GIB:-250}

USER_DATA=$(jq -Rrs '.' <<CLOUD
#cloud-config
users:
  - name: nemo
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat ~/.ssh/id_ed25519.pub)
CLOUD
)
SUBNET_ID=$(nebius vpc subnet list --format jsonpath='{.items[0].metadata.id}')
VM_ID=$(nebius compute instance create --name "$NAME" \
  --resources-platform "$PLATFORM" --resources-preset "$PRESET" \
  --boot-disk-managed-disk-name "$NAME-boot" --boot-disk-managed-disk-type network_ssd \
  --boot-disk-managed-disk-size-gibibytes "$DISK_GIB" --boot-disk-managed-disk-block-size-bytes 4096 \
  --boot-disk-managed-disk-source-image-family-image-family "$IMAGE_FAMILY" \
  --boot-disk-attach-mode READ_WRITE --cloud-init-user-data "$USER_DATA" \
  --network-interfaces "[{\"name\":\"eth0\",\"subnet_id\":\"$SUBNET_ID\",\"ip_address\":{},\"public_ip_address\":{\"static\":true}}]" \
  --format jsonpath='{.metadata.id}')
echo "VM: $VM_ID"
sleep 20
IP=$(nebius compute instance get --id "$VM_ID" --format json | jq -r '.status.network_interfaces[0].public_ip_address.address | split("/")[0]')
echo "Public IP: $IP"
echo "Next: scp infra/start-nims.sh nemo@$IP: && ssh nemo@$IP 'NGC_API_KEY=nvapi-... bash start-nims.sh'"
