# klaʊdbot for the Zermo business Ultra

Stock Android operator console. Does not unlock the bootloader. Replaces
Google as the digital assistant, talks to a Rein host, opens Mailkit, and
forwards the business line to a personal number.

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

On the phone: Setup → save Rein `http://<tailscale-ip>:4318` and token,
Mailkit URL, personal number. Then **Set klaʊdbot as digital assistant**.

Host:

```sh
rein serve --mobile --host <this-machine-tailscale-ip> --port 4318
```

## Wipe to operator-only

Factory-resets the Ultra (keeps ADB keys), reinstalls only klaʊdbot, disables
Google/Gemini/Bixby/T-Mobile/Kids preload. Dialer, keyboard, camera, WebView,
and Play services stay so the line still works.

```sh
./wipe-operator-phone.sh check
./wipe-operator-phone.sh wipe --i-understand-wipe
```

The wipe command waits for reboot, then provisions. If One UI still shows a
wizard, skip Google restore and Samsung extras. Then paste Rein host, bearer,
Mailkit, and the personal number in klaʊdbot Setup.
