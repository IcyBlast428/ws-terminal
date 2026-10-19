# Node-agent deployment

This deployment runs one root terminal agent per Linux node. It uses host PID/network namespaces and privileged containers. The shell enters the host namespaces with `nsenter`; the file API resolves the host filesystem through `/proc/1/root`, including absolute symbolic links. Service dependencies remain inside the image.

## Build and distribute

Build on a connected Linux machine matching the node CPU architecture:

```bash
docker build -t ws-terminal:1.2.0 .
docker tag ws-terminal:1.2.0 registry.internal.example/ws-terminal:1.2.0
docker push registry.internal.example/ws-terminal:1.2.0
```

The frontend bundle is checked in under `public/assets/editor.bundle.js`. To change editor sources, run `npm ci` and `npm run build` before building the image. Image build downloads the base image, OS packages, and npm dependencies. Application startup does not download anything.

To transfer an image without a registry:

```bash
docker save ws-terminal:1.2.0 -o ws-terminal-1.2.0-linux-amd64-image.tar
sha256sum ws-terminal-1.2.0-linux-amd64-image.tar > ws-terminal-1.2.0-linux-amd64-image.tar.sha256
```

Import into the Kubernetes runtime on every target node. For containerd, a typical command is `ctr -n k8s.io images import ws-terminal-1.2.0-linux-amd64-image.tar`; use the actual containerd socket/namespace for your distribution. A Docker import alone does not populate a separate Kubernetes containerd image store. Set the manifest image to the imported exact name and `imagePullPolicy: Never` for a strictly preloaded deployment.

## Deploy

The supplied image registry name is an example and must be replaced. Port 8002 must be free on each node. `/bin/bash` and `/root` refer to the host; adjust them for nodes that use another shell or home directory.

Create the namespace and Secret first. Do not apply the placeholder token unchanged:

```bash
kubectl create namespace ws-terminal
kubectl label namespace ws-terminal pod-security.kubernetes.io/enforce=privileged
kubectl -n ws-terminal create secret generic ws-terminal-access --from-file=token=/secure/path/terminal-token
kubectl apply -f deploy/kubernetes/daemonset.yaml
kubectl -n ws-terminal rollout status daemonset/ws-terminal
kubectl -n ws-terminal get pods -o wide
```

The token file must contain a token of at least 24 characters without a trailing newline. The default manifest tolerates `NoSchedule` taints, including control-plane taints. Add a node selector if only a subset of nodes should run the agent. Nodes with custom `NoExecute` taints may require explicit additional tolerations.

Browse to `http://NODE_IP:8002`. Node identity is taken from the Downward API. No NodePort Service is needed. For HTTPS, place a node-specific reverse proxy in front; route all HTTP and WebSocket requests to the same node.

## Upgrade and state

Use versioned images or immutable digests. The default update replaces at most one instance at a time with no surge, because two agents on one node cannot both bind port 8002. Active terminal sessions end when their Pod or service process restarts. The reconnect grace period covers network interruptions only.

Backups are stored on each node under `/var/lib/ws-terminal/backups` and survive Pod recreation. Defaults: 10 versions per path and a 256 MiB total history cap. Terminal output replay is in memory, capped at 1 MiB per session; older disconnected output can be discarded with a visible notice.

```bash
kubectl -n ws-terminal set image daemonset/ws-terminal terminal=registry.internal.example/ws-terminal:NEW_VERSION
kubectl -n ws-terminal rollout status daemonset/ws-terminal
kubectl -n ws-terminal rollout undo daemonset/ws-terminal
```

Changing a Secret injected as an environment variable requires restarting Pods to adopt the new token. Existing terminal sessions end during that restart. Session limits and resource limits apply to the agent and normally its child commands; operations that delegate work to host systemd may create work outside the Pod's cgroup.

The repository contains a deployment template. A real Kubernetes cluster, node admission policy, SELinux/AppArmor settings, node architectures, and host shell compatibility must be verified on the target cluster.

See [local acceptance and remaining cluster checks](ACCEPTANCE.md). Exported compressed image archives can be loaded with `docker load -i FILE`; verify their SHA-256 companions before import. For Kubernetes/containerd, decompress to a tar first and use the runtime import command described above. Do not treat a Docker load as a Kubernetes import.

Optional encrypted drafts are also stored in `/var/lib/ws-terminal/drafts` on the same per-node state volume. The key must remain private and stable across Pod recreation. Drafts expire after one hour by default; do not move draft state between untrusted nodes or treat it as a backup system.
