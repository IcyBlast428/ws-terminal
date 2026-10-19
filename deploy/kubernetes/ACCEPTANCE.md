# 1.2.0 local acceptance

Validated on WSL Ubuntu 24.04, Linux x86_64 with Node.js 24.19.0:

- 37 tests passed with no skips, including real Linux PTY disconnect/replay/close, login isolation, encrypted draft persistence/expiry/tamper detection/capacity, directory pagination/search, hidden file names, exclusive Save As, batch copy/move conflicts, symbolic links, root/descendant protections and copy budgets.
- Browser acceptance passed on desktop (1440 x 900) and mobile (390 x 844), using headless Edge: editor, exact UTF-8 BOM/CRLF, backup restore, diff, external changes, uploads/downloads, hidden files, reconnection to the same PTY/PID, tab close, drag split preview, resizing, sidebar visibility and restored file layout.
- Workflow acceptance passed: manual same-PTY recovery after refresh with a visible retention countdown; explicit terminal termination; multiline paste confirmation and cancellation; optional encrypted draft recovery; save/discard/cancel close; side-by-side manual merge; permission/proxy errors that preserve the editor; reauthentication without losing edits; hidden file creation; paging and searching beyond 500 entries.
- Workspace browser acceptance passed: multi-select and keyboard file copy, conflict-safe move with open-tab path updates, recursive duplicate including hidden files, batch deletion, exact-byte Save As, per-file Save All conflicts, keyboard command palette, terminal rename, search and reopen from tab overview, focus/restore without changing split ratios, and breadcrumbs/path completion. The new endpoints reject unauthenticated and cross-origin requests.
- Container host mode passed: root shell and file API both read a unique fixture created on the WSL host, proving they operate the same host filesystem. Save As, nested directory copy, no-overwrite conflicts, move and a terminal started directly in the requested host directory also passed. Immediate input sent on WebSocket open is exercised so working-directory validation cannot lose the first command.
- Ordinary container mode passed with `--network=none`: startup, login, file API, multiple PTYs, close and exit work without outbound connectivity.
- Offline program bundle extracted and passed CPU/libc/Node ABI/native module validation.
- Exported Linux amd64 image and program bundle have SHA-256 companion files.

The Linux program archive requires a compatible Node.js runtime. The image includes Node.js. Builds need network access or pre-populated build dependencies; neither packaged runtime downloads dependencies at startup.

This is not Kubernetes cluster acceptance. Verify the target cluster's admission policy, privileged container allowance, host namespaces, port conflicts, architecture, runtime image import, taints, SELinux/AppArmor, persistent state, node routing and upgrade behavior before rollout. Use HTTPS and restricted network access for root terminals.

Official references: [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/) and [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/).
