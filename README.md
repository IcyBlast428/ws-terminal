# WS Terminal

面向 Linux 内网服务器的离线 Web Terminal。浏览器通过 HTTP/WebSocket 连接服务，后端使用 PTY 启动本机 shell，不依赖 SSH，也不需要开放 22 端口。

运行时不访问 CDN 或互联网。前端使用项目内的 `xterm.js`、CodeMirror 和 Lucide 图标，后端使用 Node.js、`ws` 和 `node-pty`。

## 1.1 使用流程改进

- 刷新后不自动创建终端；会话列表显示剩余保留时间，可手动恢复同一个 PTY。接管已连接会话前需要确认。服务或 Pod 重启仍会结束会话。
- 顶部“结束终端”与关闭终端标签含义一致，都会结束对应进程，不再使用容易误解的“断开”。
- 键盘和右键粘贴统一处理；含换行或控制字符时展示目标节点、用户、目录及内容预览，确认后才发送。单行普通粘贴保持快捷，并保留终端括号粘贴模式。
- 关闭未保存的文件提供“保存并关闭 / 放弃修改 / 取消”。保存失败或发生冲突时保持标签和编辑内容，不会强行关闭。
- 可手动开启短期草稿自动备份，默认关闭。草稿以 AES-256-GCM 加密保存在服务器，默认 60 分钟到期；浏览器仅保留随机标识和开关，不保存正文。刷新后必须手动选择恢复，恢复本身不写回原文件。
- 冲突可在左右并排窗口中查看磁盘版本并编辑合并结果，采用结果后仍需保存；保存时继续校验磁盘版本，不提供绕过冲突的强制覆盖。
- 目录支持“加载更多”和“搜索当前目录全部条目”，与仅筛选已加载条目明确区分。跨页目录变化会提示刷新，避免混合不同版本的列表；允许创建和重命名 `.env` 等隐藏文件，但仍拒绝路径穿越。
- 文件权限、登录过期、上传失败和代理异常在对应操作区域显示，不再将局部错误误报为终端断线。重新登录后保留当前编辑，可重试保存。

## 工作区功能

- 登录后显示节点名、IP、执行用户和宿主机/容器模式；浏览器标题也包含节点名。
- 网络短暂断开保留原 PTY，默认允许 5 分钟内重连，补发最多 1 MiB 的输出。主动关闭标签、执行 `exit`、退出登录仍会结束对应会话。
- 文本编辑支持行号、语法高亮、搜索替换、行号跳转和 `Ctrl+S`；保留 UTF-8 BOM、LF/CRLF 与文件末尾空行。
- 保存前可对比修改，自动备份旧内容；支持历史预览和恢复。默认每个路径保留 10 份，总容量 256 MiB，旧备份自动清理。
- 每 8 秒及页面重新获得焦点时检测外部修改；没有本地改动时刷新，有本地改动时提示冲突而不覆盖编辑内容。
- 文件上传有进度和取消功能；同名文件可跳过、改名或覆盖，覆盖前备份且保留权限和所有权。上传/下载默认上限 100 MiB。
- 目录树提供路径跳转、当前目录筛选、收藏、隐藏文件开关和属性查看。目录大小仅手动计算，限制 10 秒或 20000 条目，不跨文件系统、不跟随符号链接，可取消，结果不完整时明确提示。
- 刷新恢复已打开的文件标签和分屏比例，不自动创建 Terminal。草稿恢复默认关闭；短暂断开留下的终端可在会话列表中恢复或关闭。
- 会话列表显示当前登录创建的终端。操作记录展示节点、来源、时间和文件/会话操作，不记录令牌、文件内容或 shell 命令。

## 镜像与 DaemonSet

已提供多阶段 `Dockerfile` 和 [DaemonSet 部署说明](deploy/kubernetes/README.md)。镜像内含 Node.js 和 Linux PTY 模块，不要求目标节点安装 Node.js 或 npm。

```bash
docker build -t ws-terminal:1.1.0 .
```

宿主机模式需要特权容器和宿主机 PID/网络命名空间：Terminal 进入宿主机环境，文件树访问同一宿主机文件系统。普通容器模式只操作容器自身，不能将容器内的 root 误认为宿主机 root。节点端口 8002 必须空闲，镜像 CPU 架构必须匹配；请按部署说明替换镜像地址、配置 Secret，并在目标集群验收。

页面支持同时创建多个独立 Terminal。登录后不会自动启动 shell，需要点击工作区的 `+` 创建 Terminal。把标签拖到工作区的上、下、左、右边缘时会先显示半屏预览，释放鼠标后形成嵌套分屏；分隔条可拖动调整比例，双击恢复五五分。关闭 Terminal 标签会立即关闭 WebSocket，并由后端终止对应 PTY 进程组；在 shell 中执行 `exit` 也会关闭对应标签。顶部字号步进器或 `Ctrl+鼠标滚轮` 可在 10–24 之间调整所有 Terminal 的文字大小。框选 Terminal 内容会自动复制；右键可直接粘贴。

左侧目录树登录后默认展开 Linux 根目录，并与 Terminal 的工作目录相互独立；执行 `cd` 不会改变当前浏览位置。侧栏可通过顶部图标隐藏或展开，也可拖动侧栏与工作区之间的竖向分隔条调整宽度，双击分隔条恢复默认宽度。目录树默认使用更大的 14px 字号。目录树可创建文件和目录、重命名以及删除文件或空目录，`.` 开头的隐藏条目默认不显示，可用开关显示。普通文件显示实际大小；目录不自动递归计算总大小，避免浏览 `/`、挂载点或大型目录时造成持续磁盘扫描。UTF-8 文本文件可在工作区标签中编辑和保存，保存前会校验内容版本，避免静默覆盖磁盘上的外部修改。目录树和文本编辑器也支持 `Ctrl+鼠标滚轮` 调整字号。

## 推荐部署结构

```text
浏览器 http://服务器IP:8002
              |
              v
       Nginx 0.0.0.0:8002
              |
              v
    WS Terminal 127.0.0.1:8765
              |
              v
      Linux PTY -> root /bin/bash
```

这种方式只对内网开放 Nginx 的 `8002`。也可以不使用 Nginx，让 WS Terminal 直接监听 `0.0.0.0:8002`。

## 安全措施

- 强制设置至少 24 字符的访问 token，拒绝空值、短值和示例值
- token 只在登录时提交一次，随后使用短期随机会话 cookie
- 原始 token 不写入 URL、浏览器存储或 terminal 环境变量
- 登录失败按来源 IP 限速；Nginx 模式只信任来自本机代理的来源地址
- 限制登录会话、来源记录、terminal 数量和 WebSocket 消息大小
- 文本编辑限制文件大小和并发操作，拒绝二进制及无效 UTF-8 文件
- 文件保存使用内容版本冲突检测；新建和改名允许隐藏名称，拒绝路径分隔符和 `.` / `..`
- 目录删除仅允许空目录，不提供递归删除
- 退出或登录过期会撤销由该登录打开的所有 terminal
- WebSocket 使用心跳，并根据浏览器实际渲染确认控制 PTY 输出速度
- 空闲超时、断线保留期结束或服务停止时清理 PTY 进程组
- 默认记录连接和退出状态，不记录命令内容

> 默认配置会以 `root` 启动网页 shell。任何获得 token 的人都等同于获得服务器 root 权限。请仅在受信内网使用，并优先配置 HTTPS、来源访问控制和足够强的随机 token。

## 环境要求

- Linux x86_64 或 arm64
- Node.js 20 或更高版本
- 可选：Nginx、systemd
- 目标机安装 `node-pty` 时需要 Python 3、`make`、GCC/G++

## 制作离线包

在能够联网且架构与目标服务器一致的 Linux 机器上执行：

```bash
npm ci --omit=dev
bash scripts/prepare-offline-bundle.sh
```

包名包含 CPU 架构、libc 和 Node ABI，例如：

```text
ws-terminal-1.1.0-linux-x86_64-glibc-nodeabi137-offline.tgz
```

同时会生成 SHA-256 文件。把两个文件传入内网服务器后执行：

```bash
sha256sum -c ws-terminal-1.1.0-linux-x86_64-glibc-nodeabi137-offline.tgz.sha256
sudo mkdir -p /opt/ws-terminal
sudo tar -xzf ws-terminal-1.1.0-linux-x86_64-glibc-nodeabi137-offline.tgz -C /opt/ws-terminal
cd /opt/ws-terminal
bash scripts/check-offline-runtime.sh
```

实际 ABI 数字以生成的文件名为准。检查脚本会验证 CPU 架构、libc、glibc 最低版本、Node ABI 和 `node-pty` 原生模块。

生成的前端资源已随源码提交，制作离线包不需要重新编译。如果修改 `public/source/editor.js`，先在构建机执行 `npm ci` 和 `npm run build`，再打包。离线包不包含 Node.js 运行时；目标机需预装相匹配的 Node.js，或改用包含运行时的容器镜像。

## Nginx + systemd 部署

创建程序和配置目录：

```bash
sudo chown -R root:root /opt/ws-terminal
sudo chmod -R u=rwX,go=rX /opt/ws-terminal
sudo mkdir -p /etc/ws-terminal
sudo cp /opt/ws-terminal/deploy/ws-terminal.env.example /etc/ws-terminal/ws-terminal.env
sudo chown root:root /etc/ws-terminal/ws-terminal.env
sudo chmod 600 /etc/ws-terminal/ws-terminal.env
openssl rand -base64 32
```

把生成值写入 `/etc/ws-terminal/ws-terminal.env`：

```ini
WS_TERMINAL_TOKEN=这里替换为随机内容
```

配置文件默认让后端仅监听本机：

```ini
WS_TERMINAL_HOST=127.0.0.1
WS_TERMINAL_PORT=8765
WS_TERMINAL_TRUST_PROXY=1
WS_TERMINAL_CWD=/root
```

启动后台服务：

```bash
sudo cp /opt/ws-terminal/deploy/ws-terminal.service /etc/systemd/system/ws-terminal.service
sudo systemctl daemon-reload
sudo systemctl enable --now ws-terminal
sudo systemctl status ws-terminal
```

配置 Nginx 对外监听 8002：

```bash
sudo cp /opt/ws-terminal/deploy/nginx-ws-terminal.conf /etc/nginx/conf.d/ws-terminal.conf
sudo nginx -t
sudo systemctl reload nginx
```

现在访问：

```text
http://服务器IP:8002
```

启用防火墙时，只需向可信内网开放 TCP 8002。后端 8765 仅监听回环地址。

在 WSL Ubuntu 24.04 中试运行时，安装 Nginx 后可直接执行：

```bash
sudo bash scripts/install-wsl-demo.sh "$PWD"
```

脚本会安装到 `/opt/ws-terminal`、生成或保留访问 token，并以 `root` 启动 Nginx 与 systemd 服务。

## 修改访问 token

交互式修改 token：

```bash
sudo bash /opt/ws-terminal/scripts/set-token.sh
```

也可以直接传入至少 24 字符的新 token：

```bash
sudo bash /opt/ws-terminal/scripts/set-token.sh 'replace-with-your-own-strong-token'
```

脚本会保持配置文件为 root-only 权限并重启服务，已有浏览器登录和 terminal 会立即失效。

## 直接监听 8002

不使用 Nginx 时，复制 `.env.example` 为 `.env`，设置随机 token，然后执行：

```bash
chmod 600 .env
npm ci --omit=dev
bash scripts/start.sh
```

`.env.example` 默认配置为：

```ini
WS_TERMINAL_HOST=0.0.0.0
WS_TERMINAL_PORT=8002
```

`start.sh` 不会覆盖 `.env`，命令行或已有环境变量仍具有更高优先级。

## HTTPS

内网 HTTP 可以工作，但 token、命令和终端输出会明文传输。如果内网中存在不可信设备，建议在 Nginx 上部署内部 CA 证书。通过 HTTPS 访问时，登录 cookie 会自动增加 `Secure` 属性。

## 常用配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `WS_TERMINAL_HOST` | `127.0.0.1` | 后端监听地址 |
| `WS_TERMINAL_PORT` | `8765` | 后端监听端口 |
| `WS_TERMINAL_TOKEN` | 无 | 必填，至少 24 字符 |
| `WS_TERMINAL_SHELL` | `$SHELL` 或 `/bin/bash` | shell 的绝对路径 |
| `WS_TERMINAL_CWD` | 服务用户家目录 | terminal 初始目录 |
| `WS_TERMINAL_MAX_SESSIONS` | `8` | 最大并发 terminal 数 |
| `WS_TERMINAL_MAX_DIRECTORY_ENTRIES` | `500` | 目录树单次最多返回的条目数 |
| `WS_TERMINAL_MAX_DIRECTORY_REQUESTS` | `4` | 每个 terminal 最多并发目录请求数 |
| `WS_TERMINAL_MAX_FILE_BYTES` | `1048576` | 单个文本文件读取和保存大小上限 |
| `WS_TERMINAL_MAX_FILE_REQUESTS` | `2` | 每个 terminal 最多并发文件操作数 |
| `WS_TERMINAL_IDLE_TIMEOUT_SECONDS` | `3600` | 无用户输入后的关闭时间 |
| `WS_TERMINAL_MAX_SESSION_SECONDS` | `28800` | 单个 terminal 最长时间 |
| `WS_TERMINAL_LOGIN_TTL_SECONDS` | `28800` | 浏览器登录有效期 |
| `WS_TERMINAL_MAX_LOGIN_SESSIONS` | `256` | 服务端最多保留的登录数 |
| `WS_TERMINAL_MAX_LOGIN_SESSIONS_PER_ADDRESS` | `8` | 每个来源最多登录数 |
| `WS_TERMINAL_TRUST_PROXY` | `0` | 仅在本机可信反向代理前设为 `1` |
| `WS_TERMINAL_SECURE_COOKIE` | `auto` | 可设为 `true` 强制 HTTPS cookie |
| `WS_TERMINAL_HOST_MODE` | `0` | `1` 时通过宿主机 PID 1 操作节点，只用于具备必要权限的容器 |
| `WS_TERMINAL_NODE_NAME` | 本机主机名 | 页面及日志中的节点标识 |
| `WS_TERMINAL_NODE_IP` | 自动获取 | 可通过 Kubernetes Downward API 指定宿主机 IP |
| `WS_TERMINAL_RECONNECT_GRACE_SECONDS` | `300` | 断线后保留 PTY 的时间，不跨服务重启 |
| `WS_TERMINAL_REPLAY_BYTES` | `1048576` | 每个终端的内存输出回放上限 |
| `WS_TERMINAL_MAX_TRANSFER_BYTES` | `104857600` | 单个上传/下载文件上限；Nginx 的 body 上限也需相应调整 |
| `WS_TERMINAL_BACKUP_DIR` | `/var/lib/ws-terminal/backups` | 备份文件位置，含敏感内容，应保持仅 root 可读 |
| `WS_TERMINAL_BACKUP_COUNT` | `10` | 每个路径保留版本数，`0` 禁用自动备份 |
| `WS_TERMINAL_BACKUP_MAX_BYTES` | `268435456` | 所有备份数据的总容量上限 |
| `WS_TERMINAL_DRAFT_DIR` | `/var/lib/ws-terminal/drafts` | 加密草稿及服务器密钥位置，目录仅服务用户可读写 |
| `WS_TERMINAL_DRAFT_TTL_SECONDS` | `3600` | 草稿有效期；服务运行时定期及访问时清理 |

## 权限说明

terminal 中的命令默认以 `root` 执行，可以读写整台服务器。程序和 token 文件也由 root 持有，因此 root terminal 本身能够读取和修改它们；访问 token 是唯一的登录边界，不应通过聊天、URL 或日志传播。

左侧目录树和文本编辑通过登录会话保护的 HTTP 接口独立工作，不依赖任何 Terminal WebSocket。页面打开后从 `/` 开始按需读取；点击目录只改变文件浏览位置，Terminal 中执行 `cd` 不会联动目录树。符号链接不会自动递归展开，避免目录环。

点击目录树中的普通文件或符号链接会在工作区打开文本编辑标签。重复点击同一路径会切换到已有标签；可以点击保存或使用 `Ctrl+S`。编辑器显示时会折叠一个文件末尾的行结束符，保存时再按原格式补回，使末尾空行数量与 Vim 等 Linux 编辑器一致且不改变原始文件。重新读取会在存在未保存修改时要求确认；磁盘内容已被其他进程修改时，保存会停止并要求重新读取。超过配置上限、二进制或非 UTF-8 文件不会在浏览器中展开，可继续通过 terminal 使用对应命令处理。

目录树默认隐藏 `.` 开头的条目。普通文件右侧显示大小；目录右侧标为“目录”，手动计算后在弹窗中显示大小或部分结果。顶部按钮在当前目录新建文件或目录，每个条目的操作菜单提供重命名和删除；删除目录不递归，目录非空时会失败。所有文件操作都以运行服务的用户权限执行，默认即 root 权限。

Terminal 框选内容后会自动写入剪贴板，`Ctrl+C` 在存在选区时复制，否则仍发送中断信号。右键直接粘贴依赖浏览器安全剪贴板权限，在 `localhost` 或 HTTPS 下可用；通过普通内网 IP 的 HTTP 页面访问时，浏览器可能只允许使用原生右键菜单粘贴。

`SIGHUP` 可以清理普通 shell、前台任务和大部分后台任务。通过 `nohup`、`setsid` 或其他方式主动脱离终端的进程可能继续运行；如需严格隔离，应为会话配置容器或独立 cgroup。

## 检查和诊断

```bash
curl http://127.0.0.1:8765/api/health
curl http://服务器IP:8002/api/health
```

预期结果：

```json
{"ok":true,"name":"ws-terminal","version":"1.1.0"}
```

验证登录、WebSocket 和 PTY 命令链路：

```bash
WS_TERMINAL_TEST_URL=http://127.0.0.1:8765 \
WS_TERMINAL_TEST_TOKEN='配置中的访问token' \
npm run smoke:linux
```

按上述 systemd 方式安装后，也可以让脚本读取 root-only token 并通过 Nginx 验证完整链路：

```bash
sudo bash /opt/ws-terminal/scripts/smoke-installed.sh
```

## 草稿与测试

草稿在最近编辑停止约 350ms 后提交，只有显示备份完成才说明服务器已接收。网络断开、页面被立即终止或服务器磁盘故障时，最后尚未提交的修改仍可能丢失。每个浏览器标识最多 20 份 / 16 MiB 草稿，服务总计最多 512 份 / 64 MiB；达到上限时明确提示，不静默覆盖其他草稿。

草稿不代替正式备份。加密密钥与密文均在服务器上，不能防御拥有服务器 root 权限的操作者；清空浏览器站点数据会丢失恢复标识。草稿过期后不能恢复，停止服务期间不会执行清理。请通过 HTTPS 保护传输。

Linux 开发测试：`npm ci` 后运行 `npm run check`、`npm test`。浏览器验收还需在测试机单独安装 Playwright/浏览器，设置 `WS_TERMINAL_TEST_URL` 和 `WS_TERMINAL_TEST_TOKEN` 后执行 `npm run smoke:browser`、`npm run smoke:workflows`。可通过 `WS_TERMINAL_PLAYWRIGHT_PATH` 指定现有 `playwright-core` 模块，通过 `WS_TERMINAL_BROWSER_PATH` 指定浏览器，截图默认写入忽略提交的 `test-results/`。这些是测试依赖，不是离线运行依赖。

前端打包组件的许可证见 [第三方声明](public/assets/THIRD-PARTY-NOTICES.txt)。实际令牌、运行配置、依赖目录、离线包和截图不应提交到源码仓库。

## 当前边界

- 网络中断支持原 PTY 重连；刷新不自动恢复终端标签，可在会话列表手动恢复；遗留会话会在保留期到期后关闭。服务或 Pod 重启会结束全部 PTY
- 文本编辑仅支持 UTF-8，不提供二进制编辑；上传/下载可以处理二进制文件
- 文件路径、分屏布局、收藏、字号及随机草稿标识保存在当前浏览器中，不包含文件内容或令牌；草稿正文仅在手动开启后加密保存在服务器
- 所有 terminal 都以同一个 root 用户运行，不提供多用户权限映射
- 页面操作记录为当前进程最近 200 条；完整元数据日志输出到 systemd journal 或容器日志，不记录命令内容，不构成不可篡改的审计系统
- 自动备份用于撤销编辑/覆盖上传，不是整机备份；删除文件前仍须自行确认和备份
- DaemonSet 模板需要在目标集群验证准入策略、SELinux/AppArmor、节点架构和宿主机 shell；本地容器验证不等于集群验收
