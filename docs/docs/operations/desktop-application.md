---
title: Desktop application
---

# Desktop application

ProPR Desktop runs the existing Web UI inside a sandboxed Electron application and connects it to one or more ProPR
instances. The first release supports Linux and macOS. It does not change browser Web UI, CLI, API, or self-hosted behavior.

## Platform and runtime matrix

| Desktop target | Packages | Existing instance | Guided local setup |
| --- | --- | --- | --- |
| Linux x64 | DEB, RPM, ZIP | Yes | Yes, when Docker and the published runtime images pass the host checks |
| Linux arm64 | DEB, RPM, ZIP | Yes | Yes, when Docker and the published runtime images pass the host checks |
| macOS Intel | DMG, ZIP | Yes | No; remote/loopback connection only |
| macOS Apple Silicon | DMG, ZIP | Yes | No; remote/loopback connection only |
| Windows | None in the first release | Deferred | Deferred |

Choose the package matching the operating system and CPU. Internal release-candidate packages can be unsigned. A public
macOS release is ready only after Developer ID signing, notarization, stapling, and signed update-feed verification in the
protected release jobs; an unsigned internal build is not evidence of those gates.

## First launch and connection

On Linux, choose **Set up this computer** to install a desktop-managed local stack, or **Connect to an existing instance**
to use a stack that is already running. On macOS, use the existing-instance path. Enter an HTTPS API origin for remote
instances; cleartext HTTP is accepted only for explicit loopback development origins.

The app validates compatibility and the instance's public identity before authentication. If authentication is required,
select **Sign in in browser**, complete the instance-supplied browser approval, and return to the app. The approval URL
comes from the validated API response; the renderer cannot replace it. A ProPR Connect discovery result or
`propr://connect` link opens a confirmation screen and never pairs, switches profiles, or sends credentials automatically.

ProPR sends external links through Electron's `shell.openExternal`, which opens the operating system's current-user
default browser. To use Chromium, set it as that user's default HTTP and HTTPS handler in the operating-system settings.
ProPR has no app-specific browser selection and does not change the system browser automatically.

After connection, use **Connected: _instance name_** to open the profile manager. You can add, switch, edit, remove, retry,
or re-pair profiles. Non-secret profile metadata survives relaunch. Offline profiles remain available for retry. A revoked
or expired profile requires browser pairing again. If a managed tunnel origin or public identity changes, treat it as a
new trust generation and confirm and pair again.

## Native tray and menu verification

Use a real Linux desktop panel or the macOS menu bar. The automated Xvfb boundary proves that Electron can create and
close the native `Menu.popup()` used for Linux primary activation, but a bare Xvfb server has no tray manager and cannot
prove shell-owned XEmbed or StatusNotifierItem activation.

1. Start the desktop app without enabling notifications. Confirm startup does not request notification permission or
   change **Settings → Desktop notifications**. The quiet defaults are **Enable on this device** (master delivery),
   **Task started**, and **Task completed** off; **Task failed** and **Needs attention** are selected but remain inactive
   until master delivery is enabled.
2. Before connecting, open the tray menu once with primary click, dismiss it by physically clicking outside, then open it
   again and dismiss it with Escape before opening it once with right-click. On a top Linux panel, confirm the primary
   menu is anchored directly below the clicked icon on that monitor. Confirm **Open ProPR**, **Switch / Manage
   Instances…**, and **Quit ProPR** work from both activation paths, while account actions and the notification toggle are
   disabled.
3. Connect and sign in. Confirm **New Plan**, **Tasks**, **Plans**, **Inbox**, **Switch / Manage Instances…**,
   **Notification Settings…**, and **Pause/Resume Native Notifications** appear in both the tray and application menus.
   Task and plan counts must open their matching destinations; unavailable counts must say unavailable rather than zero.
4. Minimize and then hide the window. Invoke each destination from the tray and application menu and confirm the window is
   restored and focused. In a plan composer, confirm leaving through a native command asks before navigating.
5. Verify `CmdOrCtrl+N`, `CmdOrCtrl+1`, `CmdOrCtrl+2`, `CmdOrCtrl+3`, `CmdOrCtrl+Shift+I`, `CmdOrCtrl+,`, and
   `CmdOrCtrl+Shift+N`. On macOS also confirm About, Services, Hide, Window, and standard Edit roles remain native.
6. Pause native notifications and confirm the item becomes unchecked and reads **Resume Native Notifications** while
   delivery is disabled. Resume and confirm it becomes checked and reads **Pause Native Notifications** while delivery is
   enabled. Make the same change in Settings and reopen both menus to confirm they agree. Per-event choices must remain
   unchanged.
7. Open **Switch / Manage Instances…**, switch through the existing manager, and confirm the next command targets only the
   new instance. Sign out or disconnect and confirm stale counts disappear and account actions disable. Quit and confirm
   the tray is removed and no accelerator acts during shutdown.

For the Linux/XFCE XEmbed acceptance, log into a real XFCE X11 session and ensure the panel's **Notification Area** plugin
is enabled before launching the exact packaged `propr-desktop` executable under test as the desktop user. Do not run it
with `sudo`. Hover the 22×22 ProPR icon and verify its Active work tooltip, then perform the
primary/outside-click/primary/Escape/right sequence from step 2 with a physical pointer. Verify both primary menus open
below the top-panel icon and dismiss on the first outside click. Repeat the sequence after
minimizing and after hiding the 640×402 main window. Selecting **Open ProPR** must restore and focus that same window;
selecting **Notification Settings…** must route within that window. If the icon or
right-click menu is absent, run `xfce4-panel --restart` in that disposable acceptance session (or log out and back in),
confirm the Notification Area plugin reacquires the tray selection, and repeat before classifying an application failure.

Electron 44 has two distinct Linux paths here. ProPR's primary handler must call `Menu.popup()` because Linux
`TrayIcon` does not implement `Tray.popUpContextMenu()`. The primary popup uses a transient transparent owner at the
physical pointer's panel/work-area edge, rather than the main window, so the native Views menu runner owns its focus/grab
and placement even while the app window is hidden. Electron renders this Linux path in its Chromium/Views menu style, so
exact GTK theme equality with the right-click menu is not expected. Right activation never reaches a JavaScript
`right-click` event:
the GTK/XEmbed fallback connects `GtkStatusIcon`'s `popup_menu` signal directly to the menu installed by
`setContextMenu()`. Consequently, a working tooltip plus a working primary menu but no right menu after the panel restart
is shell-boundary evidence to report with the XFCE version, panel plugin list, and physical-pointer result; there is no
second application event that can safely synthesize the right popup. Bare Xvfb and XTest-only results are insufficient to
override that real-shell result.

## Guided Linux setup

The Linux wizard uses an app-owned private runtime directory and the same setup engine as the CLI. Before starting, make
sure the current user can run `docker info` without an interactive `sudo` prompt and can reach GitHub and the image
registry. Follow the screens to choose GitHub authentication, event intake, coding agents, and an optional user allowlist.

Setup checks prerequisites before stack mutation, initializes the private root, pulls images bound to the desktop
release, configures GitHub and agent authentication, starts the services, and verifies both health and the strict public
desktop discovery contract. That final pre-completion gate requires instance identity, browser pairing, REST bearer, and
Socket.IO bearer capabilities; a legacy `/api/compatibility` response cannot produce a completed local profile.
Interactive authentication opens in an installed terminal
(`x-terminal-emulator`, GNOME Terminal, Konsole, or xterm). The desktop waits for the authentication command itself even
when the terminal delegates work to an existing server process.

**Cancel safely** cooperatively stops the active command and waits for rollback. A failed, cancelled, or process-interrupted
run reopens in recovery. Use **Retry setup** after correcting a transient host problem, or **Review saved choices** when
credentials or other choices need to change. Successful setup continues through the same profile save, strict discovery,
browser pairing, probe, and activation path used by a manual local profile.

## Security model

- The sandboxed renderer has no Node.js, shell, arbitrary IPC, filesystem path, or credential access.
- Pairing device secrets and instance tokens stay in Electron main. Tokens are encrypted with the OS credential facility;
  Linux `basic_text` mode and unavailable secure storage fail closed.
- REST and Socket.IO credentials are injected only for the active exact origin and credential generation. Renderer-supplied
  authorization/cookies and remote response cookies are stripped.
- Discovery, profile switching, relaunch, reconnect, and tunnel rotation revalidate the credential-free public identity
  before any saved bearer can be used.
- Deep links accept only the bounded `propr://connect` and `propr://open` schemas. Unknown, secret-bearing, oversized,
  malformed, and replayed inputs are rejected without raw-input logging.
- Linux setup selections are capability-scoped in the main process. macOS does not construct a mutating local-setup host.

See [Desktop pairing protocol](./desktop-pairing.md) for the wire contract and token lifecycle.

## Troubleshooting

- **No local setup option:** it is intentionally Linux-only. On Linux, install a current package matching the host CPU.
- **Docker absent, down, or permission denied:** install/start Docker and grant the normal user access to its socket, then
  retry. Do not run the desktop application as root.
- **Authentication terminal unavailable:** install one of the supported terminal emulators and retry. Cancelling the wizard
  also cancels the owned authentication child; closing only a server-backed terminal launcher is not completion.
- **Secure storage unavailable:** start an unlocked Linux Secret Service/keyring session. Pairing does not fall back to a
  plaintext credential file.
- **Offline:** restore DNS/network/API reachability and retry the saved profile. The profile is not deleted.
- **Desktop profile token revoked or expired:** pair the profile again in the browser. A role/allowlist change can also
  require fresh authorization.
- **Repository GitHub authorization required:** `GITHUB_AUTHORIZATION_REQUIRED` and `GITHUB_REAUTH_REQUIRED` identify the
  GitHub grant used for repository access, not the desktop profile token. Sign in with GitHub again in a browser to the
  same ProPR instance, then retry the desktop repository action. Do not remove or re-pair the desktop profile for this
  recovery.
- **Incompatible:** follow the setup recovery action, which names the selected app image and required API contract. Upgrade
  to a desktop-aligned runtime; retrying an unchanged legacy image cannot complete setup. When the incompatible runtime
  is an already-running Desktop-managed stack, use **Restart with aligned runtime**. The app explicitly replaces only
  containers owned by that private stack root and starts the currently packaged images; its bind-mounted database,
  credentials, logs, repositories, and network are retained. Ordinary **Retry setup** continues to leave it untouched.
- **Tunnel root returns 404:** this can be correct. Connect tunnels expose canonical `/api/*` and `/socket.io/*` routes;
  validation uses discovery/status rather than assuming `/` is served.

Before uninstalling on macOS, choose **Quit ProPR** and wait for the app to exit; closing a window does not necessarily quit
the app. Quit normally on Linux as well. Coordinated shutdown stops new work, drains admitted pairing/setup/deep-link
operations, closes transport state, and releases the single-instance lock.

## Release verification

Pull-request validation is secretless and uses the `macos-linux-v1` profile. It builds and exercises Linux x64/arm64 and
macOS x64/arm64 artifacts, requires Windows artifacts to be absent from canonical aggregation, checks architecture, fuses,
install/relaunch/uninstall behavior, protocol delivery, credential persistence/deletion, clean shutdown, and fail-closed
signing/update configuration. Linux x64 also produces deterministic packaged visual/accessibility evidence.

Production publication is allowed only from a new protected `desktop-v<major>.<minor>.<patch>` tag at an immutable commit.
Approval-protected jobs sign and notarize both macOS architectures, sign the release manifest, aggregate the exact ten
packages plus `SHA256SUMS` and `desktop-release.json`, and fail closed before publication if any target, hash, signer,
notarization, update, environment, or tag-protection predicate is missing.

The same protected environment must provide digest-pinned `PROPR_DESKTOP_RUNTIME_APP_IMAGE` and
`PROPR_DESKTOP_RUNTIME_UI_IMAGE` references whose full commit tag equals the desktop release commit. Linux jobs verify
that both Docker Hub artifacts exist, and all package jobs embed a generated manifest bound to those digests and the
desktop API compatibility contract. This deliberately makes desktop distribution wait for the corresponding app/UI
image publication instead of falling back to an older version tag.
