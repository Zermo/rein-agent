# App Store images — klaʊdbot 1.0

Apple wants **pixel-exact PNG** (no device chrome, no status-bar mock). These were captured from the live field console at `openbot` sizes.

## Required slots

| Slot | Size | File |
| --- | --- | --- |
| iPhone 6.7" (15/16 Pro Max) | 1290 × 2796 | `iphone-67/*.png` |
| iPhone 6.9" (16 Pro Max / 17 Pro Max) | 1320 × 2868 | `iphone-69/*.png` |
| iPad 13" | 2048 × 2732 | `ipad-13/*.png` |

Drop the folders into App Store Connect → klaʊdbot → 1.0 → iPhone / iPad Previews.

Suggested order:

1. CRT keyboard (chat)
2. Field register / avatars
3. Settings / rhythm
4. Empty chat (first-run)
5. iPad split console

Do **not** upload the sign-in capture that shows the LAN bearer field.

## App icon

`AppIcon-1024.png` — 1024 × 1024 RGB, **no alpha**, **no pre-rounded corners** (Apple masks it). Wired into `ReinKlaud/Assets.xcassets/AppIcon.appiconset/`.

A new TestFlight is required for the icon to appear on device. Screenshots are listing-only.

## Review “image proof”

Apple does not want extra screenshots beyond the size slots above. Review Information can stay text (Authelia demo user). Privacy / support URLs:

- https://openbot.zermo.org/privacy
- https://openbot.zermo.org/support
