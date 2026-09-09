---
title: Voice Briefings
---

# Voice Briefings

Voice Briefings give you a short, on-demand status snapshot while several tasks or plans are running. Open **Voice briefing** from the Web UI and choose **Catch me up**. ProPR fetches the current state, displays the briefing as text, and, when the browser supports it, asks the browser or operating system to read that text aloud.

This is a **pull-based** workflow. Each briefing is a snapshot requested by the signed-in user, which makes it useful for checking parallel or long-running work without watching the dashboard. ProPR does not keep a telephone call, WebRTC session, speech session, polling loop, or background listener open while work runs. Request another briefing when you want a newer snapshot.

## Data flow, cost, and privacy

The server and browser have deliberately separate responsibilities:

1. The browser makes an authenticated `GET /api/voice/briefing` request for all work, running work, or work needing attention.
2. The ProPR server reads the current task, plan, and notification state and returns a bounded **text JSON** snapshot. This endpoint does not accept raw audio, and ProPR does not store recognition audio or the browser's recognition transcript.
3. The browser displays the text. If speech synthesis is available and the page is visible, the browser or operating system reads the supplied text aloud.
4. When the user explicitly chooses **Listen**, the browser performs one short speech-recognition attempt and gives the recognized text to the Web UI command parser.
5. A stop or follow-up command remains pending until the user confirms it. Only then does the Web UI send the action through the same authenticated task or plan API used by the corresponding visual control. For a task follow-up, the confirmed instruction is ordinary text sent through the normal task follow-up API.

ProPR therefore adds **no Twilio charge and no server TTS or voice-provider per-minute cost**. The MVP has no server voice provider and requires no voice environment variable. Hosting, network, device, browser, or vendor charges and terms may still apply independently.

Browser speech recognition is a browser/operating-system capability, not a ProPR-hosted service. Depending on the browser, device, configuration, and vendor, microphone audio **may be sent to and processed by the browser or operating-system vendor**. Do not assume recognition is local, offline, private from that vendor, or free of vendor processing. Review the applicable browser and OS privacy settings and policies before enabling microphone access.

Before its first recognition attempt, the Web UI shows this vendor-processing disclosure. A microphone request starts only after the user acknowledges it and selects **Listen**. ProPR never activates the microphone silently.

## Text Web Push is not voice playback

[Web Push](../operations/pwa-web-push.md) can deliver a text notification while an installed PWA is in the background. It does not carry briefing audio and does not make ProPR speak. Voice playback follows an explicit interaction or recognized command only while the Voice Briefing control is open and visible; it is never initiated by Push.

Moving the app into the background or locking the screen cancels active listening and playback. A completed task may produce a text Push notification, but it cannot cause background auto-play.

## Supported command grammar

Choose **Listen** for each single command. Recognition is not continuous. Commands may refer only to an item and action advertised by the latest briefing; a reference consists of `task`, `plan`, or `system` plus its displayed number. Digits and the spoken numbers one through ten are accepted.

| Intent | Supported phrases | Result |
| --- | --- | --- |
| Full briefing | `catch me up`, `give me a briefing`, `brief me` | Fetch all current briefing items. |
| Running work | `what is running`, `what's running`, `running status` | Fetch the running-work view. |
| Needs attention | `what needs attention`, `what requires attention`, `attention status` | Fetch the attention view. |
| Repeat | `repeat`, `repeat that`, `repeat the briefing`, `say that again` | Replay the latest briefing when speech synthesis is available. |
| Open | `open task 1`, `open plan one`, `open system 2` | Open the resolved, server-provided application link. This is not a mutation. |
| Stop | `stop task 1` (or another advertised numbered reference) | Stage a stop action and ask for confirmation. |
| Follow up | `follow up task 1 to rerun the tests` (or an advertised plan reference) | Stage the text instruction and ask for confirmation. |
| Decide pending action | `confirm`; `cancel` or `never mind` | Execute the one pending mutation, or discard it. |

A leading or trailing `please` is accepted. Follow-up text is limited to 1,000 characters and cannot contain a URL or API endpoint. Unknown, compound, out-of-range, ambiguous, and unadvertised commands are rejected rather than interpreted freely.

### Confirmation is mandatory for mutations

`stop` and `follow up` never mutate state from the initial transcript. ProPR shows and speaks a specific confirmation prompt, and the user must select **Confirm action** or make a separate listening request and say `confirm`. Selecting **Cancel**, saying `cancel` or `never mind`, closing the panel, or sending another command does not execute the pending mutation. `open`, briefing, and repeat commands do not mutate server state and do not require confirmation.

The grammar is intentionally closed. Voice Briefings do **not** execute arbitrary shell commands, URLs, API requests, or free-form browser navigation.

## Platform limitations

Speech synthesis and recognition support varies by browser, OS version, language, permissions, policy, and PWA installation mode. The text briefing remains usable when either speech API is missing: unsupported playback leaves the text on screen, and unsupported recognition disables **Listen**. ProPR cannot make the platform grant microphone access or restore a permission the user denied.

Voice Briefings are not designed or supported for:

- background auto-play or speaking in response to a Push notification;
- listening while the app is backgrounded or the screen is locked;
- emergency paging, alarms, or any safety-critical notification path;
- arbitrary shell commands or open-ended voice-agent behavior; or
- silent, continuous, or remotely triggered microphone activation.

Use an external, purpose-built alerting system for emergencies and guaranteed paging.

## Manual release verification checklist

Use a test account and non-sensitive spoken phrases on a real HTTPS staging origin. Browser emulation alone does not validate a physical device's microphone, speech service, background lifecycle, or PWA behavior. Record the browser and OS versions and whether synthesis and recognition are supported.

### Desktop browser

1. Open **Voice briefing**, verify the vendor-processing disclosure appears before the first recognition attempt, and verify that no microphone prompt appears until **I understand** and then **Listen** are selected.
2. Select **Catch me up**. Verify one `GET /api/voice/briefing?scope=all` returns JSON, the same briefing is visible as text, and supported speech playback starts only from that user action.
3. Select **Listen**, grant microphone permission, and exercise a briefing command, a numbered `open` command, and `repeat`.
4. Stage `stop task N` or `follow up task N to ...`. Verify no mutation request occurs before a separate **Confirm action** selection or recognized `confirm`; verify `cancel` leaves state unchanged. After confirmation, verify a text request uses the normal task or plan API and no request contains raw audio.
5. Deny microphone permission in a fresh browser profile. Verify the UI reports that access was not allowed, still provides the text briefing, and does not repeatedly or silently prompt.
6. Test a browser without `SpeechRecognition`/`webkitSpeechRecognition`. Verify **Listen** is disabled with unsupported guidance and **Catch me up** still provides the text fallback.
7. Start playback and then start recognition in separate attempts; background the tab during each. Verify playback/listening is cancelled, does not resume automatically, and no action is executed.

### Android installed PWA

1. Install ProPR from a current supported Android browser, launch the installed PWA, and repeat the disclosure, granted-permission, denied-permission, and unsupported-recognition checks that the selected browser/device permits.
2. Request a briefing and verify the visible text remains the source of truth whether or not the device speaks it.
3. Stage and cancel one mutation, then stage and confirm one mutation. Verify both require the explicit second step.
4. While playback is active and, separately, while listening is active, switch apps and lock the screen. Verify both interactions cancel and do not restart when the PWA returns to the foreground.
5. Trigger a task-completion Web Push while the PWA is backgrounded. Verify it is a text notification and does not auto-play a voice briefing.

### iOS/iPadOS Home Screen app

1. In Safari, add ProPR with **Share → Add to Home Screen**, then launch it from the Home Screen icon. Record unsupported synthesis or recognition as an expected platform capability result rather than treating the text briefing as failed.
2. Verify **Catch me up** shows text after a user action. Where recognition is available, verify disclosure and **Listen** precede the OS microphone prompt; test both allowed and denied permission states.
3. Stage and cancel one mutation, then stage and confirm one mutation. Verify no stop or follow-up request is sent before confirmation.
4. Start any supported playback/listening interaction, go Home, and lock the screen. Verify it cancels and does not resume or execute an action when the app is reopened.
5. Deliver a Web Push while the Home Screen app is closed or backgrounded. Verify the notification is text-only and that opening it does not start voice playback without a new user request.

A release is not verified until the matrix includes a denied microphone permission result, an unsupported-recognition result, background cancellation, and confirmation gating for a mutating command, in addition to the successful text briefing path.
