# 1.1.0 local acceptance

Validated on WSL Ubuntu 24.04, Linux x86_64 with Node.js 24.19.0:

- 32 tests passed with no skips, including real Linux PTY disconnect/replay/close, login isolation, encrypted draft persistence/expiry/tamper detection/capacity, directory pagination/search and hidden file names.
- Browser acceptance passed on desktop (1440 x 900) and mobile (390 x 844), using headless Edge: editor, exact UTF-8 BOM/CRLF, backup restore, diff, external changes, uploads/downloads, hidden files, reconnection to the same PTY/PID, tab close, drag split preview, resizing, sidebar visibility and restored file layout.
- Workflow acceptance passed: manual same-PTY recovery after refresh with a visible retention countdown; explicit terminal termination; multiline paste confirmation and cancellation; optional encrypted draft recovery; save/discard/cancel close; side-by-side manual merge; permission/proxy errors that preserve the editor; reauthentication without losing edits; hidden file creation; paging and searching beyond 500 entries.
- Container host mode passed: root shell and file API both read a unique fixture created on the WSL host, proving they operate the same host filesystem.
- Ordinary container mode passed with `--network=none`: startup, login, file API, multiple PTYs, close and exit work without outbound connectivity.
- Offline program bundle extracted and passed CPU/libc/Node ABI/native module validation.
- Exported Linux amd64 image and program bundle have SHA-256 companion files.

The Linux program archive requires a compatible Node.js runtime. The image includes Node.js. Builds need network access or pre-populated build dependencies; neither packaged runtime downloads dependencies at startup.

This is not Kubernetes cluster acceptance. Verify the target cluster's admission policy, privileged container allowance, host namespaces, port conflicts, architecture, runtime image import, taints, SELinux/AppArmor, persistent state, node routing and upgrade behavior before rollout. Use HTTPS and restricted network access for root terminals.

Official references: [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/) and [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/).
