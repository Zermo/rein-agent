package org.zermo.klaud

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.zermo.klaud.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_LISTEN = "listen"
    }

    private lateinit var b: ActivityMainBinding
    private val rein = ReinClient()
    private var speech: SpeechRecognizer? = null

    private val perm = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        perm.launch(
            arrayOf(
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.CALL_PHONE,
                Manifest.permission.POST_NOTIFICATIONS,
            ),
        )

        b.navAgent.setOnClickListener { show("agent") }
        b.navMail.setOnClickListener { show("mail") }
        b.navLine.setOnClickListener { show("line") }
        b.navSetup.setOnClickListener { show("setup") }

        b.send.setOnClickListener { sendTyped() }
        b.mic.setOnClickListener { startListen() }
        b.saveSetup.setOnClickListener { saveSetup() }
        b.setAssistant.setOnClickListener { openAssistantSettings() }
        b.fwdOn.setOnClickListener { forward(true) }
        b.fwdOff.setOnClickListener { forward(false) }
        b.callPersonal.setOnClickListener {
            if (!Prefs.lineReady()) {
                toast("Set the personal number first")
                return@setOnClickListener
            }
            LineControl.place(this, LineControl.callPersonalUri(Prefs.personalNumber))
        }

        b.mailView.webViewClient = WebViewClient()
        b.mailView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        bindSetup()
        bindLine()
        show("agent")
        if (intent.getBooleanExtra(EXTRA_LISTEN, false)) startListen()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_LISTEN, false)) {
            show("agent")
            startListen()
        }
    }

    private fun show(tab: String) {
        b.panelAgent.visibility = if (tab == "agent") View.VISIBLE else View.GONE
        b.mailView.visibility = if (tab == "mail") View.VISIBLE else View.GONE
        b.panelMail.visibility = View.GONE
        b.panelLine.visibility = if (tab == "line") View.VISIBLE else View.GONE
        b.panelSetup.visibility = if (tab == "setup") View.VISIBLE else View.GONE
        if (tab == "mail") loadMail()
    }

    private fun bindSetup() {
        b.host.setText(Prefs.host)
        b.token.setText(Prefs.token)
        b.mailkit.setText(Prefs.mailkitUrl)
        b.mailkitToken.setText(Prefs.mailkitToken)
        b.personal.setText(Prefs.personalNumber)
    }

    private fun bindLine() {
        b.personalLine.setText(Prefs.personalNumber)
        b.fwdStatus.text = if (Prefs.forwardingOn) {
            "Forwarding ON → ${Prefs.personalNumber}"
        } else {
            "Forwarding OFF — calls stay on this business line"
        }
    }

    private fun saveSetup() {
        Prefs.host = b.host.text.toString()
        Prefs.token = b.token.text.toString()
        Prefs.mailkitUrl = b.mailkit.text.toString()
        Prefs.mailkitToken = b.mailkitToken.text.toString()
        Prefs.personalNumber = b.personal.text.toString()
        b.personalLine.setText(Prefs.personalNumber)
        bindLine()
        toast("Saved")
    }

    private fun sendTyped() {
        val text = b.composer.text.toString().trim()
        if (text.isEmpty()) return
        b.composer.text?.clear()
        handleUtterance(text)
    }

    private fun handleUtterance(text: String) {
        append("you", text)
        val local = LocalIntents.handle(this, text)
        if (local == "MAIL") {
            show("mail")
            append("klaud", "Opening Mailkit.")
            return
        }
        if (local != null) {
            append("klaud", local)
            return
        }
        if (!Prefs.reinReady()) {
            append("klaud", "No Rein host yet. Put the Mac gateway in Setup, then try again.")
            return
        }
        append("klaud", "…")
        rein.ask(
            text,
            onUpdate = { runOnUiThread { replaceLastAgent(it) } },
            onDone = { result -> runOnUiThread { replaceLastAgent(result.text) } },
        )
    }

    private fun append(who: String, text: String) {
        val label = if (who == "you") "OPERATOR" else "klaʊdbot"
        b.transcript.append("$label\n$text\n\n")
        val scroll = b.transcript.parent as? android.widget.ScrollView
        scroll?.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun replaceLastAgent(text: String) {
        val raw = b.transcript.text.toString()
        val idx = raw.lastIndexOf("klaʊdbot\n")
        if (idx >= 0) {
            b.transcript.text = raw.substring(0, idx) + "klaʊdbot\n$text\n\n"
        } else {
            append("klaud", text)
        }
    }

    private fun startListen() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            perm.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            toast("Speech recognition is not available on this device")
            return
        }
        if (speech == null) speech = SpeechRecognizer.createSpeechRecognizer(this)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }
        speech?.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                b.status.text = "listening"
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {
                b.status.text = "thinking"
            }
            override fun onError(error: Int) {
                b.status.text = "ready"
                toast("Listen error $error")
            }
            override fun onResults(results: Bundle) {
                b.status.text = "ready"
                val said = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    .orEmpty()
                if (said.isNotBlank()) handleUtterance(said)
            }
            override fun onPartialResults(partialResults: Bundle) {
                val said = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                if (!said.isNullOrBlank()) b.status.text = said
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        speech?.startListening(intent)
    }

    private fun loadMail() {
        if (!Prefs.mailReady()) {
            b.mailView.loadData(
                "<html><body style='background:#151b22;color:#9aa9b8;font-family:sans-serif;padding:24px'>Set the Mailkit URL in Setup. Engine stays on your Mac; this phone is the client.</body></html>",
                "text/html",
                "utf-8",
            )
            return
        }
        val url = buildString {
            append(Prefs.mailkitUrl)
            if (!Prefs.mailkitUrl.contains("/ui")) append("/ui/")
            if (Prefs.mailkitToken.isNotBlank()) append("?token=").append(Prefs.mailkitToken)
        }
        b.mailView.loadUrl(url)
    }

    private fun forward(on: Boolean) {
        if (!Prefs.lineReady()) {
            toast("Set your personal number in Setup or Line")
            show("setup")
            return
        }
        val uri = if (on) LineControl.forwardUri(Prefs.personalNumber) else LineControl.cancelUri()
        LineControl.place(this, uri)
        Prefs.forwardingOn = on
        bindLine()
    }

    private fun openAssistantSettings() {
        startActivity(Intent(android.provider.Settings.ACTION_VOICE_INPUT_SETTINGS))
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        speech?.destroy()
        super.onDestroy()
    }
}
